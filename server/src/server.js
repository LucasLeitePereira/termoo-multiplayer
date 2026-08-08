import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { InMemoryRoomStore } from "./rooms/InMemoryRoomStore.js";
import { createWsHandlers } from "./ws/handlers.js";

const PORT = Number(process.env.PORT ?? 3000);
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS ?? 30 * 60 * 1000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_DIST_DIR = process.env.CLIENT_DIST_DIR
  ? path.resolve(process.env.CLIENT_DIST_DIR)
  : path.resolve(__dirname, "../client-dist");

const app = Fastify({ logger: true });
const store = new InMemoryRoomStore();
const handlers = createWsHandlers(store);

app.get("/health", async () => {
  return { status: "ok" };
});

if (existsSync(CLIENT_DIST_DIR)) {
  await app.register(fastifyStatic, {
    root: CLIENT_DIST_DIR,
    prefix: "/",
    wildcard: false,
  });

  app.get("/*", async (request, reply) => {
    if (request.url === "/health") {
      return reply.callNotFound();
    }

    return reply.sendFile("index.html");
  });
}

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
