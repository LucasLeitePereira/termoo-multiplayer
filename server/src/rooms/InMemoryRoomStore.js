import { RoomStore } from "./RoomStore.js";

function randomId(length = 6) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}

export class InMemoryRoomStore extends RoomStore {
  constructor() {
    super();
    this.rooms = new Map();
  }

  create(initialState) {
    let roomId = randomId();
    while (this.rooms.has(roomId)) {
      roomId = randomId();
    }

    const state = {
      ...initialState,
      roomId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
    };

    this.rooms.set(roomId, state);
    return state;
  }

  get(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  update(roomId, updater) {
    const current = this.get(roomId);
    if (!current) {
      return null;
    }

    const next = updater({ ...current });
    if (!next) {
      return null;
    }

    next.lastActivityAt = Date.now();
    this.rooms.set(roomId, next);
    return next;
  }

  delete(roomId) {
    return this.rooms.delete(roomId);
  }

  cleanup(olderThanMs) {
    const now = Date.now();
    let removed = 0;

    for (const [roomId, room] of this.rooms.entries()) {
      if (now - room.lastActivityAt > olderThanMs) {
        this.rooms.delete(roomId);
        removed += 1;
      }
    }

    return removed;
  }
}
