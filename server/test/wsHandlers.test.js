import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRoomStore } from "../src/rooms/InMemoryRoomStore.js";
import { createWsHandlers } from "../src/ws/handlers.js";

function createMockSocket() {
  const sent = [];

  return {
    OPEN: 1,
    readyState: 1,
    sent,
    send(raw) {
      sent.push(JSON.parse(raw));
    },
  };
}

function sendEvent(handlers, ws, type, payload = {}) {
  handlers.onMessage(ws, JSON.stringify({ type, payload }));
}

function getPayloads(ws, type) {
  return ws.sent
    .filter((message) => message.type === type)
    .map((message) => message.payload);
}

function getLastErrorCode(ws) {
  const errors = getPayloads(ws, "error");
  return errors.at(-1)?.code;
}

test("match with multiple rounds only ends after both players finish", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 2 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;

  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  const room = store.get(roomId);
  room.roundWords = ["AMIGO", "LIVRO"];

  sendEvent(handlers, wsA, "guess", { roomId, word: "AMIGO" });
  sendEvent(handlers, wsA, "guess", { roomId, word: "LIVRO" });

  assert.equal(getPayloads(wsA, "game_over").length, 0);
  assert.equal(getPayloads(wsB, "game_over").length, 0);

  for (let i = 0; i < 12; i += 1) {
    sendEvent(handlers, wsB, "guess", { roomId, word: "ZZZZZ" });
  }

  const gameOverA = getPayloads(wsA, "game_over");
  const gameOverB = getPayloads(wsB, "game_over");

  assert.equal(gameOverA.length, 1);
  assert.equal(gameOverB.length, 1);

  assert.equal(gameOverA[0].matchSummary.reason, "more_words_guessed");
  assert.equal(gameOverA[0].you.wordsGuessed, 2);
  assert.equal(gameOverA[0].opponent.wordsGuessed, 0);
  assert.deepEqual(gameOverA[0].roundWords, ["AMIGO", "LIVRO"]);
  assert.equal(gameOverA[0].roundsSummary.length, 2);
  assert.equal(gameOverA[0].roundsSummary[0].word, "AMIGO");
  assert.equal(gameOverA[0].roundsSummary[1].word, "LIVRO");
});

test("tie on words is decided by fewer total attempts", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;

  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  const room = store.get(roomId);
  room.roundWords = ["AMIGO"];

  sendEvent(handlers, wsA, "guess", { roomId, word: "AMIGO" });
  assert.equal(getPayloads(wsA, "game_over").length, 0);

  sendEvent(handlers, wsB, "guess", { roomId, word: "ZZZZZ" });
  sendEvent(handlers, wsB, "guess", { roomId, word: "AMIGO" });

  const gameOverA = getPayloads(wsA, "game_over")[0];
  const gameOverB = getPayloads(wsB, "game_over")[0];

  assert.equal(gameOverA.matchSummary.reason, "fewer_total_attempts");
  assert.equal(gameOverA.you.wordsGuessed, 1);
  assert.equal(gameOverA.you.attempts, 1);
  assert.equal(gameOverA.opponent.wordsGuessed, 1);
  assert.equal(gameOverA.opponent.attempts, 2);

  assert.equal(gameOverB.matchSummary.reason, "fewer_total_attempts");
  assert.equal(gameOverB.you.attempts, 2);
  assert.equal(gameOverB.opponent.attempts, 1);
});

test("room accepts a third player and sends opponents list", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();
  const wsC = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;

  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsC, "join_room", { roomId, playerName: "C" });

  const roomJoinedC = getPayloads(wsC, "room_joined")[0];
  assert.ok(roomJoinedC);
  assert.equal(Array.isArray(roomJoinedC.opponents), true);
  assert.equal(roomJoinedC.opponents.length, 2);
  assert.deepEqual(roomJoinedC.opponents.map((entry) => entry.name).sort(), [
    "A",
    "B",
  ]);
});

test("opponent_progress is broadcast to all other players", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();
  const wsC = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;

  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsC, "join_room", { roomId, playerName: "C" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  const room = store.get(roomId);
  room.roundWords = ["AMIGO"];

  const beforeA = getPayloads(wsA, "opponent_progress").length;
  const beforeC = getPayloads(wsC, "opponent_progress").length;

  sendEvent(handlers, wsB, "guess", { roomId, word: "ZZZZZ" });

  const payloadA = getPayloads(wsA, "opponent_progress").at(-1);
  const payloadC = getPayloads(wsC, "opponent_progress").at(-1);

  assert.equal(getPayloads(wsA, "opponent_progress").length, beforeA + 1);
  assert.equal(getPayloads(wsC, "opponent_progress").length, beforeC + 1);
  assert.equal(payloadA.playerName, "B");
  assert.equal(payloadC.playerName, "B");
  assert.ok(payloadA.playerId);
  assert.equal(payloadA.playerId, payloadC.playerId);
});

test("only owner can start a match", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });

  sendEvent(handlers, wsB, "start_game", { roomId });

  assert.equal(getLastErrorCode(wsB), "NOT_OWNER");
  assert.equal(getPayloads(wsA, "game_started").length, 0);
  assert.equal(getPayloads(wsB, "game_started").length, 0);
});

test("start_game requires at least two active players", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;

  sendEvent(handlers, wsA, "start_game", { roomId });

  assert.equal(getLastErrorCode(wsA), "NOT_ENOUGH_PLAYERS");
  assert.equal(getPayloads(wsA, "game_started").length, 0);
});

test("start_game emits game_started to all players and becomes idempotent", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });

  sendEvent(handlers, wsA, "start_game", { roomId });

  const gameStartedA = getPayloads(wsA, "game_started");
  const gameStartedB = getPayloads(wsB, "game_started");

  assert.equal(gameStartedA.length, 1);
  assert.equal(gameStartedB.length, 1);
  assert.equal(gameStartedA[0].roomStatus, "playing");
  assert.equal(gameStartedB[0].roomStatus, "playing");

  sendEvent(handlers, wsA, "start_game", { roomId });
  assert.equal(getLastErrorCode(wsA), "MATCH_ALREADY_STARTED");
});

test("owner is transferred when owner leaves before start", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();
  const wsC = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsC, "join_room", { roomId, playerName: "C" });

  sendEvent(handlers, wsA, "leave_room", { roomId });

  const playerLeftB = getPayloads(wsB, "player_left").at(-1);
  const playerLeftC = getPayloads(wsC, "player_left").at(-1);

  assert.ok(playerLeftB.ownerId);
  assert.equal(playerLeftB.ownerId, playerLeftC.ownerId);
  assert.equal(playerLeftB.roomStatus, "waiting");

  sendEvent(handlers, wsB, "start_game", { roomId });
  assert.equal(getPayloads(wsB, "game_started").length, 1);
  assert.equal(getPayloads(wsC, "game_started").length, 1);
});

test("match keeps playing when a non-owner leaves and two players remain", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();
  const wsC = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsC, "join_room", { roomId, playerName: "C" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  const room = store.get(roomId);
  room.roundWords = ["AMIGO"];

  sendEvent(handlers, wsC, "leave_room", { roomId });

  const leftPayloadA = getPayloads(wsA, "player_left").at(-1);
  const leftPayloadB = getPayloads(wsB, "player_left").at(-1);

  assert.equal(leftPayloadA.roomStatus, "playing");
  assert.equal(leftPayloadB.roomStatus, "playing");
  assert.equal(leftPayloadA.activeCount, 2);
  assert.equal(getPayloads(wsA, "game_over").length, 0);
  assert.equal(getPayloads(wsB, "game_over").length, 0);

  sendEvent(handlers, wsA, "guess", { roomId, word: "AMIGO" });
  assert.equal(getLastErrorCode(wsA), undefined);
  assert.equal(getPayloads(wsA, "guess_result").length, 1);
});

test("owner leaving during playing transfers owner and match continues", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();
  const wsC = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsC, "join_room", { roomId, playerName: "C" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  const room = store.get(roomId);
  room.roundWords = ["AMIGO"];

  sendEvent(handlers, wsA, "leave_room", { roomId });

  const leftPayloadB = getPayloads(wsB, "player_left").at(-1);
  const leftPayloadC = getPayloads(wsC, "player_left").at(-1);

  assert.equal(leftPayloadB.roomStatus, "playing");
  assert.equal(leftPayloadC.roomStatus, "playing");
  assert.ok(leftPayloadB.ownerId);
  assert.equal(leftPayloadB.ownerId, leftPayloadC.ownerId);
  assert.equal(leftPayloadB.ownerId, store.get(roomId).ownerId);

  sendEvent(handlers, wsB, "guess", { roomId, word: "AMIGO" });
  assert.equal(getLastErrorCode(wsB), undefined);
  assert.equal(getPayloads(wsB, "guess_result").length, 1);
});

test("when only one player remains the match stays in playing and remaining player can keep guessing", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  const room = store.get(roomId);
  room.roundWords = ["AMIGO"];

  sendEvent(handlers, wsB, "leave_room", { roomId });

  const leftPayloadA = getPayloads(wsA, "player_left").at(-1);
  assert.equal(leftPayloadA.roomStatus, "playing");
  assert.equal(leftPayloadA.activeCount, 1);
  assert.equal(getPayloads(wsA, "opponent_left").length, 0);
  assert.equal(getPayloads(wsA, "game_over").length, 0);
  assert.equal(store.get(roomId)?.status, "playing");

  sendEvent(handlers, wsA, "guess", { roomId, word: "AMIGO" });
  assert.equal(getLastErrorCode(wsA), undefined);
  assert.equal(getPayloads(wsA, "guess_result").length, 1);
});

test("socket close follows the same leave rules during playing", () => {
  const store = new InMemoryRoomStore();
  const handlers = createWsHandlers(store);
  const wsA = createMockSocket();
  const wsB = createMockSocket();
  const wsC = createMockSocket();

  sendEvent(handlers, wsA, "create_room", { playerName: "A", rounds: 1 });
  const roomId = getPayloads(wsA, "room_created")[0].roomId;
  sendEvent(handlers, wsB, "join_room", { roomId, playerName: "B" });
  sendEvent(handlers, wsC, "join_room", { roomId, playerName: "C" });
  sendEvent(handlers, wsA, "start_game", { roomId });

  handlers.onClose(wsC);

  const leftPayloadA = getPayloads(wsA, "player_left").at(-1);
  const leftPayloadB = getPayloads(wsB, "player_left").at(-1);

  assert.equal(leftPayloadA.roomStatus, "playing");
  assert.equal(leftPayloadB.roomStatus, "playing");
  assert.equal(leftPayloadA.activeCount, 2);
  assert.equal(leftPayloadB.activeCount, 2);
});
