import {
  MAX_ATTEMPTS,
  WORD_LENGTH,
  didWin,
  evaluateGuess,
  isValidGuess,
  normalizeWord,
  pickSecretWord,
} from "../game/gameLogic.js";

const MIN_ROUNDS = 1;
const MAX_ROUNDS = 20;
const MAX_ACTIVE_PLAYERS = 3;
const MIN_PLAYERS_TO_START = 2;

function send(ws, type, payload = {}) {
  if (!ws || ws.readyState !== ws.OPEN) {
    return;
  }

  ws.send(JSON.stringify({ type, payload }));
}

function sendError(ws, code, message) {
  send(ws, "error", { code, message });
}

function parseRounds(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric)) {
    return 1;
  }

  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, numeric));
}

function buildRoundWords(rounds, firstWord) {
  const words = Array.from({ length: rounds }, () => pickSecretWord());
  words[0] = firstWord;
  return words;
}

function buildRoomState(secretWord, rounds) {
  return {
    roundWords: buildRoundWords(rounds, secretWord),
    settings: {
      rounds,
      maxAttempts: MAX_ATTEMPTS,
      wordLength: WORD_LENGTH,
    },
    status: "waiting",
    ownerId: null,
    players: [],
  };
}

function createPlayer(name, ws) {
  return {
    id: crypto.randomUUID(),
    name,
    ws,
    attempts: [],
    currentRound: 1,
    roundsFinished: 0,
    wordsGuessed: 0,
    totalAttemptsUsed: 0,
    matchFinishedAt: null,
    roundHistory: [],
    lastRoundResult: null,
    done: false,
    won: false,
    left: false,
  };
}

function playerSafeState(player) {
  return {
    id: player.id,
    name: player.name,
    attemptsUsed: player.attempts.length,
    currentRound: player.currentRound,
    roundsFinished: player.roundsFinished,
    wordsGuessed: player.wordsGuessed,
    totalAttemptsUsed: player.totalAttemptsUsed,
    done: player.done,
    won: player.won,
  };
}

function getActivePlayers(room) {
  return room.players.filter((player) => !player.left);
}

function resolvePlayer(room, ws) {
  return room.players.find((player) => player.ws === ws) ?? null;
}

function roomStatusPayload(room, viewerId = "") {
  const activePlayers = getActivePlayers(room);
  const activeCount = activePlayers.length;

  return {
    ownerId: room.ownerId,
    roomStatus: room.status,
    activeCount,
    minPlayersToStart: MIN_PLAYERS_TO_START,
    canStart:
      room.status === "waiting" &&
      activeCount >= MIN_PLAYERS_TO_START &&
      viewerId === room.ownerId,
  };
}

function getPlayerRoundWord(room, player) {
  const idx = Math.max(
    0,
    Math.min(room.settings.rounds - 1, player.currentRound - 1),
  );
  return room.roundWords[idx];
}

function findRoundResult(history, round) {
  return history.find((entry) => entry.round === round) ?? null;
}

function comparePlayersForWinner(a, b) {
  if (a.wordsGuessed !== b.wordsGuessed) {
    return b.wordsGuessed - a.wordsGuessed;
  }

  if (a.totalAttemptsUsed !== b.totalAttemptsUsed) {
    return a.totalAttemptsUsed - b.totalAttemptsUsed;
  }

  const aTime = a.matchFinishedAt ?? Number.MAX_SAFE_INTEGER;
  const bTime = b.matchFinishedAt ?? Number.MAX_SAFE_INTEGER;
  if (aTime !== bTime) {
    return aTime - bTime;
  }

  return a.id.localeCompare(b.id);
}

function resolveWinnerReason(sortedPlayers) {
  if (sortedPlayers.length <= 1) {
    return "walkover";
  }

  const first = sortedPlayers[0];
  const second = sortedPlayers[1];

  if (first.wordsGuessed !== second.wordsGuessed) {
    return "more_words_guessed";
  }

  if (first.totalAttemptsUsed !== second.totalAttemptsUsed) {
    return "fewer_total_attempts";
  }

  return "finished_first_on_tie";
}

function buildOpponentResult(player, winnerId) {
  return {
    id: player.id,
    name: player.name,
    won: player.id === winnerId,
    wordsGuessed: player.wordsGuessed,
    attempts: player.totalAttemptsUsed,
    roundsFinished: player.roundsFinished,
    roundHistory: player.roundHistory,
    finishedAt: player.matchFinishedAt,
  };
}

function buildStandings(sortedPlayers, winnerId) {
  return sortedPlayers.map((player, index) => ({
    rank: index + 1,
    id: player.id,
    name: player.name,
    won: player.id === winnerId,
    wordsGuessed: player.wordsGuessed,
    totalAttemptsUsed: player.totalAttemptsUsed,
    finishedAt: player.matchFinishedAt,
    roundsFinished: player.roundsFinished,
  }));
}

function buildRoundsSummary(room, viewer, opponents) {
  return room.roundWords.map((word, idx) => {
    const round = idx + 1;
    const youRound = findRoundResult(viewer.roundHistory, round);

    const opponentRounds = opponents.map((opponent) => {
      const roundResult = findRoundResult(opponent.roundHistory, round);
      return {
        id: opponent.id,
        name: opponent.name,
        won: Boolean(roundResult?.won),
        attempts: roundResult?.attempts ?? null,
      };
    });

    return {
      round,
      word,
      you: {
        won: Boolean(youRound?.won),
        attempts: youRound?.attempts ?? null,
      },
      opponent: opponentRounds[0] ?? null,
      opponents: opponentRounds,
    };
  });
}

function buildGameOverPayload({
  room,
  player,
  sortedActivePlayers,
  winner,
  reason,
  completedAt,
}) {
  const opponentsRaw = sortedActivePlayers.filter(
    (candidate) => candidate.id !== player.id,
  );

  const opponents = opponentsRaw.map((opponent) =>
    buildOpponentResult(opponent, winner.id),
  );

  return {
    word: player.lastRoundResult?.word ?? null,
    rounds: room.settings.rounds,
    roundWords: room.roundWords,
    roundsSummary: buildRoundsSummary(room, player, opponentsRaw),
    you: {
      won: winner.id === player.id,
      wordsGuessed: player.wordsGuessed,
      attempts: player.totalAttemptsUsed,
      roundsFinished: player.roundsFinished,
      roundHistory: player.roundHistory,
      finishedAt: player.matchFinishedAt,
    },
    opponent: opponents[0] ?? null,
    opponents,
    standings: buildStandings(sortedActivePlayers, winner.id),
    matchSummary: {
      winnerId: winner.id,
      winnerName: winner.name,
      reason,
      totalRounds: room.settings.rounds,
      completedAt,
    },
  };
}

function maybeFinishMatch(room, store) {
  const activePlayers = getActivePlayers(room);

  if (activePlayers.length === 0) {
    store.delete(room.roomId);
    return;
  }

  const shouldFinish = activePlayers.every((player) => player.done);
  if (!shouldFinish) {
    return;
  }

  const sorted = [...activePlayers].sort(comparePlayersForWinner);
  const winner = sorted[0];
  const reason = resolveWinnerReason(sorted);
  const completedAt = Date.now();

  room.status = "finished";

  for (const player of sorted) {
    send(
      player.ws,
      "game_over",
      buildGameOverPayload({
        room,
        player,
        sortedActivePlayers: sorted,
        winner,
        reason,
        completedAt,
      }),
    );
  }

  store.delete(room.roomId);
}

function onStartGame(payload, ws, store) {
  const roomId = String(payload?.roomId ?? "")
    .trim()
    .toUpperCase();
  const room = store.get(roomId);

  if (!room) {
    sendError(ws, "ROOM_NOT_FOUND", "Sala nao encontrada.");
    return;
  }

  const requester = resolvePlayer(room, ws);
  if (!requester || requester.left) {
    sendError(ws, "PLAYER_NOT_IN_ROOM", "Voce nao pertence a sala.");
    return;
  }

  if (requester.id !== room.ownerId) {
    sendError(ws, "NOT_OWNER", "Apenas o dono da sala pode iniciar.");
    return;
  }

  if (room.status !== "waiting") {
    sendError(ws, "MATCH_ALREADY_STARTED", "A partida ja foi iniciada.");
    return;
  }

  const activePlayers = getActivePlayers(room);
  if (activePlayers.length < MIN_PLAYERS_TO_START) {
    sendError(
      ws,
      "NOT_ENOUGH_PLAYERS",
      "Sao necessarios pelo menos 2 jogadores para iniciar.",
    );
    return;
  }

  prepareRoomForNextMatch(room);

  room.status = "playing";

  for (const target of activePlayers) {
    send(target.ws, "game_started", {
      roomId: room.roomId,
      players: activePlayers.map((player) => playerSafeState(player)),
      rounds: room.settings.rounds,
      maxAttempts: MAX_ATTEMPTS,
      wordLength: WORD_LENGTH,
      ...roomStatusPayload(room, target.id),
    });
  }
}

function onCreateRoom(payload, ws, store) {
  const playerName =
    String(payload?.playerName ?? "Jogador 1").trim() || "Jogador 1";
  const rounds = parseRounds(payload?.rounds);

  const room = store.create(buildRoomState(pickSecretWord(), rounds));
  const player = createPlayer(playerName, ws);

  room.players.push(player);
  room.ownerId = player.id;

  send(ws, "room_created", {
    roomId: room.roomId,
    player: playerSafeState(player),
    rounds: room.settings.rounds,
    currentRound: player.currentRound,
    maxAttempts: MAX_ATTEMPTS,
    wordLength: WORD_LENGTH,
    ...roomStatusPayload(room, player.id),
  });
}

function onJoinRoom(payload, ws, store) {
  const roomId = String(payload?.roomId ?? "")
    .trim()
    .toUpperCase();
  const room = store.get(roomId);

  if (!room) {
    sendError(ws, "ROOM_NOT_FOUND", "Sala nao encontrada.");
    return;
  }

  if (room.status !== "waiting") {
    sendError(ws, "ROOM_IN_PROGRESS", "A partida desta sala ja comecou.");
    return;
  }

  const activePlayers = getActivePlayers(room);
  if (activePlayers.length >= MAX_ACTIVE_PLAYERS) {
    sendError(ws, "ROOM_FULL", "Sala lotada.");
    return;
  }

  const playerName =
    String(
      payload?.playerName ?? `Jogador ${activePlayers.length + 1}`,
    ).trim() || `Jogador ${activePlayers.length + 1}`;
  const player = createPlayer(playerName, ws);

  room.players.push(player);

  const opponents = getActivePlayers(room).filter(
    (candidate) => candidate.id !== player.id,
  );

  send(ws, "room_joined", {
    roomId: room.roomId,
    player: playerSafeState(player),
    opponent: opponents[0] ? playerSafeState(opponents[0]) : null,
    opponents: opponents.map((opponent) => playerSafeState(opponent)),
    rounds: room.settings.rounds,
    currentRound: player.currentRound,
    maxAttempts: MAX_ATTEMPTS,
    wordLength: WORD_LENGTH,
    ...roomStatusPayload(room, player.id),
  });

  for (const target of opponents) {
    const targetOpponents = getActivePlayers(room).filter(
      (candidate) => candidate.id !== target.id,
    );

    send(target.ws, "player_joined", {
      roomId: room.roomId,
      playerName: player.name,
      player: playerSafeState(player),
      opponent: playerSafeState(player),
      opponents: targetOpponents.map((candidate) => playerSafeState(candidate)),
      rounds: room.settings.rounds,
      currentRound: target.currentRound,
      maxAttempts: MAX_ATTEMPTS,
      wordLength: WORD_LENGTH,
      ...roomStatusPayload(room, target.id),
    });
  }
}

function onGuess(payload, ws, store) {
  const roomId = String(payload?.roomId ?? "")
    .trim()
    .toUpperCase();
  const word = String(payload?.word ?? "");

  const room = store.get(roomId);
  if (!room) {
    sendError(ws, "ROOM_NOT_FOUND", "Sala nao encontrada.");
    return;
  }

  const player = resolvePlayer(room, ws);
  if (!player || player.left) {
    sendError(ws, "PLAYER_NOT_IN_ROOM", "Voce nao pertence a sala.");
    return;
  }

  if (room.status !== "playing") {
    sendError(ws, "ROOM_NOT_READY", "A sala ainda nao esta pronta para jogar.");
    return;
  }

  if (player.done) {
    sendError(ws, "PLAYER_FINISHED", "Voce ja terminou a partida.");
    return;
  }

  if (!isValidGuess(word)) {
    sendError(
      ws,
      "INVALID_GUESS",
      "Palpite invalido. Use uma palavra com exatamente 5 letras.",
    );
    return;
  }

  const roundNumber = player.currentRound;
  const totalRounds = room.settings.rounds;

  if (roundNumber > totalRounds) {
    sendError(ws, "PLAYER_FINISHED", "Voce ja concluiu todas as rodadas.");
    return;
  }

  const normalizedGuess = normalizeWord(word);
  const secretWord = getPlayerRoundWord(room, player);
  const feedback = evaluateGuess(normalizedGuess, secretWord);
  player.attempts.push({ word: normalizedGuess, feedback });

  const attemptsUsedInRound = player.attempts.length;
  const attemptsLeftInRound = MAX_ATTEMPTS - attemptsUsedInRound;
  const roundWon = didWin(feedback);
  const roundDone = roundWon || attemptsUsedInRound >= MAX_ATTEMPTS;

  let nextRound = roundNumber;

  if (roundDone) {
    player.roundsFinished += 1;
    if (roundWon) {
      player.wordsGuessed += 1;
    }

    player.totalAttemptsUsed += attemptsUsedInRound;
    player.lastRoundResult = {
      round: roundNumber,
      won: roundWon,
      attempts: attemptsUsedInRound,
      word: secretWord,
    };
    player.roundHistory.push({ ...player.lastRoundResult });
    player.attempts = [];

    if (player.roundsFinished >= totalRounds) {
      player.done = true;
      player.won = true;
      if (!player.matchFinishedAt) {
        player.matchFinishedAt = Date.now();
      }
      nextRound = totalRounds;
    } else {
      nextRound = player.roundsFinished + 1;
      player.currentRound = nextRound;
      player.done = false;
      player.won = false;
    }
  }

  send(ws, "guess_result", {
    feedback,
    attemptsUsed: attemptsUsedInRound,
    attemptsLeft: attemptsLeftInRound,
    won: roundWon,
    roundDone,
    round: roundNumber,
    rounds: totalRounds,
    nextRound,
    done: player.done,
    guess: normalizedGuess,
  });

  const currentActivePlayers = getActivePlayers(room);
  for (const target of currentActivePlayers) {
    if (target.id === player.id) {
      continue;
    }

    send(target.ws, "opponent_progress", {
      playerId: player.id,
      playerName: player.name,
      attemptsUsed: attemptsUsedInRound,
      attemptsLeft: attemptsLeftInRound,
      won: roundWon,
      done: player.done,
      roundDone,
      round: roundNumber,
      rounds: totalRounds,
      nextRound,
      attemptIndex: attemptsUsedInRound - 1,
      feedback,
    });
  }

  maybeFinishMatch(room, store);
}

function notifyPlayerLeft(room, leftPlayer, remainingPlayers) {
  const payload = {
    roomId: room.roomId,
    playerId: leftPlayer.id,
    playerName: leftPlayer.name,
    activeCount: remainingPlayers.length,
    players: remainingPlayers.map((player) => playerSafeState(player)),
    ...roomStatusPayload(room),
  };

  for (const player of remainingPlayers) {
    send(player.ws, "player_left", payload);
  }
}

function resetPlayerForMatch(player) {
  player.attempts = [];
  player.currentRound = 1;
  player.roundsFinished = 0;
  player.wordsGuessed = 0;
  player.totalAttemptsUsed = 0;
  player.matchFinishedAt = null;
  player.roundHistory = [];
  player.lastRoundResult = null;
  player.done = false;
  player.won = false;
}

function prepareRoomForNextMatch(room) {
  room.roundWords = buildRoundWords(room.settings.rounds, pickSecretWord());

  for (const player of getActivePlayers(room)) {
    resetPlayerForMatch(player);
  }
}

function leaveRoom(roomId, ws, store) {
  const room = store.get(roomId);
  if (!room) {
    return;
  }

  const player = resolvePlayer(room, ws);
  if (!player || player.left) {
    return;
  }

  const wasPlaying = room.status === "playing";

  player.left = true;
  if (wasPlaying) {
    player.done = true;
    if (!player.matchFinishedAt) {
      player.matchFinishedAt = Date.now();
    }
  }

  room.players = room.players.filter((candidate) => candidate.id !== player.id);
  const remainingPlayers = getActivePlayers(room);

  if (remainingPlayers.length === 0) {
    store.delete(roomId);
    return;
  }

  if (room.ownerId === player.id) {
    room.ownerId = remainingPlayers[0].id;
  }

  notifyPlayerLeft(room, player, remainingPlayers);

  if (wasPlaying) {
    maybeFinishMatch(room, store);
    return;
  }

  room.status = "waiting";
}

export function createWsHandlers(store) {
  return {
    onMessage(ws, rawMessage) {
      let message;
      try {
        message = JSON.parse(rawMessage.toString("utf-8"));
      } catch {
        sendError(ws, "BAD_MESSAGE", "Mensagem invalida.");
        return;
      }

      const { type, payload } = message;

      switch (type) {
        case "create_room":
          onCreateRoom(payload, ws, store);
          break;
        case "join_room":
          onJoinRoom(payload, ws, store);
          break;
        case "guess":
          onGuess(payload, ws, store);
          break;
        case "start_game":
          onStartGame(payload, ws, store);
          break;
        case "leave_room": {
          const roomId = String(payload?.roomId ?? "")
            .trim()
            .toUpperCase();
          if (roomId) {
            leaveRoom(roomId, ws, store);
          }
          break;
        }
        default:
          sendError(ws, "UNKNOWN_EVENT", "Evento desconhecido.");
      }
    },

    onClose(ws) {
      for (const room of store.rooms.values()) {
        const player = resolvePlayer(room, ws);
        if (player) {
          leaveRoom(room.roomId, ws, store);
          return;
        }
      }
    },
  };
}
