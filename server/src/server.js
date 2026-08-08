import Fastify from "fastify";
import { WebSocketServer } from "ws";
import { InMemoryRoomStore } from "./rooms/InMemoryRoomStore.js";
import { createWsHandlers } from "./ws/handlers.js";

const PORT = Number(process.env.PORT ?? 3000);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 30 * 60 * 1000);

const app = Fastify({ logger: true });
const store = new InMemoryRoomStore();
const handlers = createWsHandlers(store);

app.get("/health", async () => {
  return { status: "ok" };
});

const start = async () => {
  try {
    await app.listen({ port: PORT, host: "0.0.0.0" });

    const wss = new WebSocketServer({ server: app.server });

    wss.on("connection", (ws) => {
      ws.on("message", (message) => handlers.onMessage(ws, message));
      ws.on("close", () => handlers.onClose(ws));
    });

    setInterval(() => {
      store.cleanup(ROOM_TTL_MS);
    }, 60 * 1000).unref();

    app.log.info(`Servidor iniciado na porta ${PORT}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
};

start();
