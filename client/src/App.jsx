import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WORD_LENGTH,
  WS_URL,
} from "./lib/constants";
import { normalizeFeedback } from "./lib/feedback";

const PHASE = {
  LOBBY: "lobby",
  WAITING: "waiting",
  PLAYING: "playing",
  FINISHED: "finished",
};

const KEYBOARD_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];
const ROUND_OPTIONS = [1, 3, 5, 8];
const LOBBY_STEP = {
  NAME: "name",
  ROOM: "room",
};
const MAX_VISIBLE_OPPONENTS = 2;

function createEmptyRows(maxAttempts, wordLength) {
  return Array.from({ length: maxAttempts }, () => ({
    word: "",
    feedback: new Array(wordLength).fill("empty"),
  }));
}

function createEmptyFeedbackRows(maxAttempts, wordLength) {
  return Array.from({ length: maxAttempts }, () =>
    new Array(wordLength).fill("empty"),
  );
}

function createDraft(wordLength) {
  return new Array(wordLength).fill("");
}

function createOpponentBoardState(maxAttempts, wordLength, round = 1) {
  return {
    attemptsUsed: 0,
    attemptsLeft: maxAttempts,
    done: false,
    round,
    feedbackRows: createEmptyFeedbackRows(maxAttempts, wordLength),
    revealState: { rowIndex: -1, token: 0 },
  };
}

function sanitizeName(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeOpponent(candidate, index = 0) {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }

  const rawId = candidate.id ?? candidate.playerId ?? candidate.opponentId;
  const name = sanitizeName(
    candidate.name ?? candidate.playerName ?? candidate.opponentName,
  );

  if (!rawId && !name) {
    return null;
  }

  const id = rawId ? String(rawId) : `name:${name.toLowerCase()}`;
  return {
    id,
    name: name || `Oponente ${index + 1}`,
    currentRound: Number(candidate.currentRound ?? 1),
  };
}

function extractOpponentsFromPayload(payload, selfId = "", selfName = "") {
  const candidates = [];

  if (Array.isArray(payload?.opponents)) {
    candidates.push(...payload.opponents);
  }

  if (Array.isArray(payload?.players)) {
    candidates.push(...payload.players);
  }

  if (payload?.opponent) {
    candidates.push(payload.opponent);
  }

  if (payload?.playerId) {
    candidates.push({
      id: payload.playerId,
      name: payload.playerName,
      currentRound: payload.currentRound,
    });
  }

  if (payload?.opponentId) {
    candidates.push({
      id: payload.opponentId,
      name: payload.opponentName,
      currentRound: payload.currentRound,
    });
  }

  if (payload?.player && (payload.player.id || payload.player.name)) {
    candidates.push(payload.player);
  }

  const normalized = candidates
    .map((item, index) => normalizeOpponent(item, index))
    .filter(Boolean);

  const deduped = new Map();
  for (const entry of normalized) {
    if (selfId && entry.id === String(selfId)) {
      continue;
    }

    if (!entry.id.startsWith("name:") && selfName && entry.name === selfName) {
      continue;
    }

    deduped.set(entry.id, entry);
  }

  const namesSeen = new Set(
    [...deduped.values()]
      .filter((entry) => !entry.id.startsWith("name:"))
      .map((entry) => entry.name),
  );

  for (const [id, entry] of deduped) {
    if (id.startsWith("name:") && namesSeen.has(entry.name)) {
      deduped.delete(id);
    }
  }

  return [...deduped.values()];
}

function getWinnerText(gameOver, youName, opponentName) {
  if (!gameOver) {
    return "";
  }

  if (gameOver.you?.won) {
    return `${youName || "Voce"} venceu`;
  }

  if (gameOver.opponent?.won) {
    return `${opponentName || "Oponente"} venceu`;
  }

  return "Resultado indefinido";
}

function getReasonText(reason) {
  if (reason === "more_words_guessed") {
    return "venceu por acertar mais palavras";
  }

  if (reason === "fewer_total_attempts") {
    return "venceu por usar menos tentativas no total";
  }

  if (reason === "finished_first_on_tie") {
    return "venceu no desempate por tempo";
  }

  if (reason === "walkover") {
    return "venceu por abandono do oponente";
  }

  return "criterio de vitoria nao informado";
}

function findRoundResult(history, round) {
  if (!Array.isArray(history)) {
    return null;
  }

  return history.find((entry) => entry.round === round) ?? null;
}

function buildRoundRows(gameOver) {
  if (!gameOver) {
    return [];
  }

  if (
    Array.isArray(gameOver.roundsSummary) &&
    gameOver.roundsSummary.length > 0
  ) {
    return gameOver.roundsSummary;
  }

  const words = Array.isArray(gameOver.roundWords) ? gameOver.roundWords : [];
  const youHistory = gameOver.you?.roundHistory ?? [];
  const opponentHistory = gameOver.opponent?.roundHistory ?? [];

  return words.map((word, idx) => {
    const round = idx + 1;
    const youRound = findRoundResult(youHistory, round);
    const opponentRound = findRoundResult(opponentHistory, round);

    return {
      round,
      word,
      you: {
        won: Boolean(youRound?.won),
        attempts: youRound?.attempts ?? null,
      },
      opponent: gameOver.opponent
        ? {
            won: Boolean(opponentRound?.won),
            attempts: opponentRound?.attempts ?? null,
          }
        : null,
    };
  });
}

function getRoundStatus(entry) {
  if (!entry || entry.attempts == null) {
    return { tone: "pending", text: "Sem dados", attemptsText: "-" };
  }

  return {
    tone: entry.won ? "win" : "lose",
    text: entry.won ? "Acertou" : "Errou",
    attemptsText: `${entry.attempts} tentativa${entry.attempts === 1 ? "" : "s"}`,
  };
}

function App() {
  const wsRef = useRef(null);
  const roundsPickerRef = useRef(null);
  const revealTimeoutRef = useRef(null);
  const matchCountdownIntervalRef = useRef(null);
  const ownRoundTimeoutRef = useRef(null);
  const matchCountdownStartedRef = useRef(false);
  const youRoundsDoneRef = useRef(new Set());
  const opponentRoundsDoneRef = useRef(new Set());
  const opponentRevealTimeoutsRef = useRef({});
  const opponentRoundTimeoutsRef = useRef({});
  const opponentWinPopupTimeoutRef = useRef(null);

  const [connectionStatus, setConnectionStatus] = useState("offline");
  const [phase, setPhase] = useState(PHASE.LOBBY);
  const [lobbyStep, setLobbyStep] = useState(LOBBY_STEP.NAME);

  const [playerName, setPlayerName] = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [roundsToPlay, setRoundsToPlay] = useState(String(ROUND_OPTIONS[1]));
  const [isRoundsMenuOpen, setIsRoundsMenuOpen] = useState(false);

  const [roomId, setRoomId] = useState("");
  const [you, setYou] = useState("");
  const [youId, setYouId] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [activeCount, setActiveCount] = useState(1);
  const [roomStatus, setRoomStatus] = useState("waiting");

  const [opponents, setOpponents] = useState([]);
  const [opponentBoards, setOpponentBoards] = useState({});

  const [wordLength, setWordLength] = useState(DEFAULT_WORD_LENGTH);
  const [maxAttempts, setMaxAttempts] = useState(DEFAULT_MAX_ATTEMPTS);
  const [totalRounds, setTotalRounds] = useState(1);
  const [currentRound, setCurrentRound] = useState(1);

  const [guesses, setGuesses] = useState([]);
  const [draftLetters, setDraftLetters] = useState(
    createDraft(DEFAULT_WORD_LENGTH),
  );
  const [cursorIndex, setCursorIndex] = useState(0);
  const [attemptsUsed, setAttemptsUsed] = useState(0);
  const [attemptsLeft, setAttemptsLeft] = useState(DEFAULT_MAX_ATTEMPTS);
  const [youDone, setYouDone] = useState(false);

  const [scoreboard, setScoreboard] = useState({
    youWords: 0,
    opponentWords: 0,
    youAttempts: 0,
    opponentAttempts: 0,
  });

  const [revealState, setRevealState] = useState({ rowIndex: -1, token: 0 });

  const [gameOver, setGameOver] = useState(null);
  const [banner, setBanner] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [matchCountdown, setMatchCountdown] = useState(null);
  const [opponentRoundWinPopup, setOpponentRoundWinPopup] = useState("");

  const draftRef = useRef(draftLetters);

  useEffect(() => {
    draftRef.current = draftLetters;
  }, [draftLetters]);

  const emptyRows = useMemo(
    () => createEmptyRows(maxAttempts, wordLength),
    [maxAttempts, wordLength],
  );

  const boardRows = useMemo(() => {
    const rows = [...guesses, ...emptyRows];
    return rows.slice(0, maxAttempts).map((row, index) => {
      if (index === guesses.length && phase !== PHASE.FINISHED) {
        return {
          word: [...draftLetters],
          feedback: row.feedback,
        };
      }
      return row;
    });
  }, [draftLetters, emptyRows, guesses, maxAttempts, phase]);

  const keyboardStateMap = useMemo(() => {
    const score = {
      empty: 0,
      absent: 1,
      present: 2,
      correct: 3,
    };

    const states = {};

    for (const row of guesses) {
      for (let i = 0; i < wordLength; i += 1) {
        const letter = row.word[i];
        if (!letter) {
          continue;
        }

        const status = row.feedback[i] || "absent";
        const current = states[letter] || "empty";
        if (score[status] > score[current]) {
          states[letter] = status;
        }
      }
    }

    return states;
  }, [guesses, wordLength]);

  const visibleOpponents = useMemo(
    () => opponents.slice(0, MAX_VISIBLE_OPPONENTS),
    [opponents],
  );

  const isOwner = Boolean(youId) && youId === ownerId;
  const canStartMatch =
    phase !== PHASE.FINISHED &&
    roomStatus === "waiting" &&
    isOwner &&
    activeCount >= 2;

  function pushToast(type, text) {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, type, text }]);

    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3600);
  }

  function send(type, payload = {}) {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      pushToast("error", "Conexao indisponivel. Tente novamente.");
      return;
    }

    wsRef.current.send(JSON.stringify({ type, payload }));
  }

  function clearOpponentTimersById(opponentId) {
    const revealTimeout = opponentRevealTimeoutsRef.current[opponentId];
    if (revealTimeout) {
      clearTimeout(revealTimeout);
      delete opponentRevealTimeoutsRef.current[opponentId];
    }

    const roundTimeout = opponentRoundTimeoutsRef.current[opponentId];
    if (roundTimeout) {
      clearTimeout(roundTimeout);
      delete opponentRoundTimeoutsRef.current[opponentId];
    }
  }

  function clearTimers() {
    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
      revealTimeoutRef.current = null;
    }

    if (matchCountdownIntervalRef.current) {
      clearInterval(matchCountdownIntervalRef.current);
      matchCountdownIntervalRef.current = null;
    }

    if (ownRoundTimeoutRef.current) {
      clearTimeout(ownRoundTimeoutRef.current);
      ownRoundTimeoutRef.current = null;
    }

    for (const timeoutId of Object.values(opponentRevealTimeoutsRef.current)) {
      clearTimeout(timeoutId);
    }
    opponentRevealTimeoutsRef.current = {};

    for (const timeoutId of Object.values(opponentRoundTimeoutsRef.current)) {
      clearTimeout(timeoutId);
    }
    opponentRoundTimeoutsRef.current = {};

    if (opponentWinPopupTimeoutRef.current) {
      clearTimeout(opponentWinPopupTimeoutRef.current);
      opponentWinPopupTimeoutRef.current = null;
    }
  }

  function closeSocket(sendLeave = true) {
    if (!wsRef.current) {
      return;
    }

    if (
      sendLeave &&
      roomId &&
      wsRef.current.readyState === WebSocket.OPEN &&
      (phase === PHASE.WAITING || phase === PHASE.PLAYING)
    ) {
      wsRef.current.send(
        JSON.stringify({ type: "leave_room", payload: { roomId } }),
      );
    }

    wsRef.current.close();
    wsRef.current = null;
  }

  function resetOwnRoundState(
    nextMaxAttempts = maxAttempts,
    nextWordLength = wordLength,
  ) {
    setGuesses([]);
    setDraftLetters(createDraft(nextWordLength));
    setCursorIndex(0);
    setAttemptsUsed(0);
    setAttemptsLeft(nextMaxAttempts);
  }

  function resetMatchState(options = {}) {
    const nextMaxAttempts = options.maxAttempts ?? maxAttempts;
    const nextWordLength = options.wordLength ?? wordLength;
    const nextRounds = options.rounds ?? 1;

    clearTimers();
    youRoundsDoneRef.current = new Set();
    opponentRoundsDoneRef.current = new Set();

    resetOwnRoundState(nextMaxAttempts, nextWordLength);

    setOpponents([]);
    setOpponentBoards({});

    setCurrentRound(1);
    setOwnerId("");
    setActiveCount(1);
    setRoomStatus("waiting");
    setScoreboard({
      youWords: 0,
      opponentWords: 0,
      youAttempts: 0,
      opponentAttempts: 0,
    });
    setTotalRounds(nextRounds);
    setYouDone(false);
    setMatchCountdown(null);
    setRevealState({ rowIndex: -1, token: 0 });
    matchCountdownStartedRef.current = false;
    setGameOver(null);
    setBanner(null);
    setOpponentRoundWinPopup("");
  }

  function startMatchCountdown() {
    if (matchCountdownStartedRef.current) {
      return;
    }

    matchCountdownStartedRef.current = true;
    setMatchCountdown(3);

    if (matchCountdownIntervalRef.current) {
      clearInterval(matchCountdownIntervalRef.current);
    }

    let secondsLeft = 3;
    matchCountdownIntervalRef.current = setInterval(() => {
      secondsLeft -= 1;

      if (secondsLeft <= 0) {
        if (matchCountdownIntervalRef.current) {
          clearInterval(matchCountdownIntervalRef.current);
          matchCountdownIntervalRef.current = null;
        }
        setMatchCountdown(null);
        return;
      }

      setMatchCountdown(secondsLeft);
    }, 1000);
  }

  function triggerReveal(rowIndex) {
    const token = Date.now();
    setRevealState({ rowIndex, token });

    if (revealTimeoutRef.current) {
      clearTimeout(revealTimeoutRef.current);
    }

    revealTimeoutRef.current = setTimeout(() => {
      setRevealState((prev) =>
        prev.token === token ? { rowIndex: -1, token: prev.token } : prev,
      );
    }, 2000);
  }

  function triggerOpponentReveal(opponentId, rowIndex) {
    const token = Date.now() + Math.random();

    setOpponentBoards((prev) => {
      const current = prev[opponentId];
      if (!current) {
        return prev;
      }

      return {
        ...prev,
        [opponentId]: {
          ...current,
          revealState: { rowIndex, token },
        },
      };
    });

    const existingTimeout = opponentRevealTimeoutsRef.current[opponentId];
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    opponentRevealTimeoutsRef.current[opponentId] = setTimeout(() => {
      setOpponentBoards((prev) => {
        const current = prev[opponentId];
        if (!current || current.revealState.token !== token) {
          return prev;
        }

        return {
          ...prev,
          [opponentId]: {
            ...current,
            revealState: { rowIndex: -1, token: current.revealState.token },
          },
        };
      });

      delete opponentRevealTimeoutsRef.current[opponentId];
    }, 1850);
  }

  function showOpponentRoundWinPopup(name) {
    setOpponentRoundWinPopup(`${name || "Um oponente"} acertou a palavra!`);

    if (opponentWinPopupTimeoutRef.current) {
      clearTimeout(opponentWinPopupTimeoutRef.current);
    }

    opponentWinPopupTimeoutRef.current = setTimeout(() => {
      setOpponentRoundWinPopup("");
      opponentWinPopupTimeoutRef.current = null;
    }, 1000);
  }

  function upsertOpponent(nextOpponent) {
    setOpponents((prev) => {
      const index = prev.findIndex((item) => item.id === nextOpponent.id);
      if (index === -1) {
        return [...prev, nextOpponent];
      }

      const copy = [...prev];
      copy[index] = {
        ...copy[index],
        ...nextOpponent,
        name: nextOpponent.name || copy[index].name,
      };
      return copy;
    });
  }

  function removeOpponentsByIds(idsToRemove) {
    if (!idsToRemove || idsToRemove.size === 0) {
      return;
    }

    for (const id of idsToRemove) {
      clearOpponentTimersById(id);
    }

    setOpponents((prev) => {
      return prev.filter((item) => !idsToRemove.has(item.id));
    });

    setOpponentBoards((prev) => {
      const next = { ...prev };
      for (const id of idsToRemove) {
        delete next[id];
      }
      return next;
    });
  }

  function setOpponentListAndBoards(
    nextOpponents,
    nextMaxAttempts = maxAttempts,
    nextWordLength = wordLength,
  ) {
    const idsToKeep = new Set(nextOpponents.map((item) => item.id));

    for (const currentId of Object.keys(opponentBoards)) {
      if (!idsToKeep.has(currentId)) {
        clearOpponentTimersById(currentId);
      }
    }

    setOpponents(nextOpponents);

    setOpponentBoards(() => {
      const boards = {};
      for (const item of nextOpponents) {
        boards[item.id] = createOpponentBoardState(
          nextMaxAttempts,
          nextWordLength,
          Number(item.currentRound ?? 1),
        );
      }
      return boards;
    });
  }

  function connectIfNeeded() {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) {
      return;
    }

    setConnectionStatus("connecting");
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnectionStatus("online");
      pushToast("success", "Conexao estabelecida.");
    };

    ws.onclose = () => {
      setConnectionStatus("offline");
    };

    ws.onerror = () => {
      pushToast("error", "Falha na comunicacao com o servidor.");
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const type = message.type;
      const payload = message.payload ?? {};

      if (type === "room_created") {
        const nextMaxAttempts = payload.maxAttempts || DEFAULT_MAX_ATTEMPTS;
        const nextWordLength = payload.wordLength || DEFAULT_WORD_LENGTH;
        const rounds = Number(payload.rounds ?? 1);

        resetMatchState({
          maxAttempts: nextMaxAttempts,
          wordLength: nextWordLength,
          rounds,
        });

        setRoomId(payload.roomId || "");
        setYou(payload.player?.name || playerName);
        const nextYouId = String(payload.player?.id ?? "");
        setYouId(nextYouId);
        setOwnerId(String(payload.ownerId ?? nextYouId));
        setActiveCount(Number(payload.activeCount ?? 1));
        setRoomStatus(String(payload.roomStatus ?? "waiting"));
        setMaxAttempts(nextMaxAttempts);
        setWordLength(nextWordLength);
        setTotalRounds(rounds);
        setCurrentRound(Number(payload.currentRound ?? 1));
        setPhase(PHASE.WAITING);
        setBanner({
          kind: "info",
          text: "Sala criada. Compartilhe o codigo e inicie quando quiser.",
        });
        pushToast("success", "Sala criada com sucesso.");
        return;
      }

      if (type === "room_joined") {
        const nextMaxAttempts = payload.maxAttempts || DEFAULT_MAX_ATTEMPTS;
        const nextWordLength = payload.wordLength || DEFAULT_WORD_LENGTH;
        const rounds = Number(payload.rounds ?? 1);

        resetMatchState({
          maxAttempts: nextMaxAttempts,
          wordLength: nextWordLength,
          rounds,
        });

        const nextYouId = String(payload.player?.id ?? "");
        const nextYouName = payload.player?.name || playerName;

        const nextOpponents = extractOpponentsFromPayload(
          payload,
          nextYouId,
          nextYouName,
        );

        setRoomId(payload.roomId || "");
        setYou(nextYouName);
        setYouId(nextYouId);
        setOwnerId(String(payload.ownerId ?? ""));
        setActiveCount(Number(payload.activeCount ?? 1));
        setRoomStatus(String(payload.roomStatus ?? "waiting"));
        setMaxAttempts(nextMaxAttempts);
        setWordLength(nextWordLength);
        setTotalRounds(rounds);
        setCurrentRound(Number(payload.currentRound ?? 1));

        setOpponentListAndBoards(
          nextOpponents,
          nextMaxAttempts,
          nextWordLength,
        );

        setPhase(PHASE.WAITING);
        setBanner({
          kind: "info",
          text:
            Number(payload.activeCount ?? 1) >= 2
              ? "Voce entrou na sala. Aguardando o dono iniciar a partida."
              : "Voce entrou na sala. Aguardando mais jogadores.",
        });

        pushToast("success", "Voce entrou na sala.");
        return;
      }

      if (type === "player_joined") {
        const joinedOpponents = extractOpponentsFromPayload(
          payload,
          youId,
          you || playerName,
        );

        if (joinedOpponents.length > 0) {
          for (const entry of joinedOpponents) {
            upsertOpponent(entry);

            setOpponentBoards((prev) => {
              if (prev[entry.id]) {
                return prev;
              }

              return {
                ...prev,
                [entry.id]: createOpponentBoardState(
                  maxAttempts,
                  wordLength,
                  Number(entry.currentRound ?? 1),
                ),
              };
            });
          }
        }

        const nextActiveCount = Number(payload.activeCount ?? activeCount);
        const nextRoomStatus = String(
          payload.roomStatus ?? roomStatus ?? "waiting",
        );

        setOwnerId(String(payload.ownerId ?? ownerId));
        setActiveCount(nextActiveCount);
        setRoomStatus(nextRoomStatus);

        if (phase !== PHASE.FINISHED) {
          if (nextRoomStatus === "playing" && nextActiveCount >= 2) {
            setPhase(PHASE.PLAYING);
          } else {
            setPhase(PHASE.WAITING);
          }
        }

        const joinedName =
          joinedOpponents[0]?.name ||
          payload.playerName ||
          payload.opponent?.name ||
          "Oponente";

        setBanner({
          kind: "info",
          text: `${joinedName} entrou. Aguardando inicio do dono da sala.`,
        });
        return;
      }

      if (type === "player_left") {
        const leftPlayerId = String(payload.playerId ?? "");
        const idsToRemove = new Set(leftPlayerId ? [leftPlayerId] : []);

        if (idsToRemove.size > 0) {
          removeOpponentsByIds(idsToRemove);
        }

        const remainingOpponents = (
          Array.isArray(payload.players) ? payload.players : []
        )
          .map((entry, index) => normalizeOpponent(entry, index))
          .filter(Boolean)
          .filter((entry) => {
            if (entry.id === leftPlayerId) {
              return false;
            }

            if (youId && entry.id === String(youId)) {
              return false;
            }

            if (
              !youId &&
              (you || playerName) &&
              entry.name === (you || playerName)
            ) {
              return false;
            }

            return true;
          });

        setOpponents(remainingOpponents);
        setOpponentBoards((prev) => {
          const next = {};

          for (const opponent of remainingOpponents) {
            next[opponent.id] =
              prev[opponent.id] ||
              createOpponentBoardState(
                maxAttempts,
                wordLength,
                Number(opponent.currentRound ?? 1),
              );
          }

          return next;
        });

        const nextActiveCount = Number(payload.activeCount ?? activeCount);
        const nextRoomStatus = String(
          payload.roomStatus ?? roomStatus ?? "waiting",
        );

        setOwnerId(String(payload.ownerId ?? ownerId));
        setActiveCount(nextActiveCount);
        setRoomStatus(nextRoomStatus);

        if (phase !== PHASE.FINISHED) {
          setPhase(
            nextRoomStatus === "playing" ? PHASE.PLAYING : PHASE.WAITING,
          );
        }

        const leftName = payload.playerName || "Jogador";
        setBanner({
          kind: "warning",
          text:
            payload.message ||
            `${leftName} saiu da sala. ${
              nextRoomStatus === "playing"
                ? "A partida continua normalmente."
                : "Aguardando mais jogadores para iniciar nova partida."
            }`,
        });

        return;
      }

      if (type === "game_started") {
        setOwnerId(String(payload.ownerId ?? ownerId));
        setActiveCount(Number(payload.activeCount ?? activeCount));
        setRoomStatus(String(payload.roomStatus ?? "playing"));

        if (phase !== PHASE.FINISHED) {
          setPhase(PHASE.PLAYING);
          startMatchCountdown();
        }

        setBanner({ kind: "success", text: "Partida iniciada. Boa sorte!" });
        return;
      }

      if (type === "guess_result") {
        const normalized = normalizeFeedback(payload.feedback, wordLength);
        const used = Number(payload.attemptsUsed ?? attemptsUsed + 1);
        const left = Number(payload.attemptsLeft ?? maxAttempts - used);
        const round = Number(payload.round ?? currentRound);
        const rounds = Number(payload.rounds ?? totalRounds);
        const roundDone = Boolean(payload.roundDone);
        const matchDone = Boolean(payload.done);
        const nextRound = Number(payload.nextRound ?? round + 1);

        setTotalRounds(rounds);
        setCurrentRound(round);

        setGuesses((prev) => [
          ...prev,
          {
            word: (payload.guess || "").toUpperCase(),
            feedback: normalized,
          },
        ]);

        triggerReveal(Math.max(0, used - 1));
        setAttemptsUsed(used);
        setAttemptsLeft(left);
        setDraftLetters(createDraft(wordLength));
        setCursorIndex(0);

        if (roundDone && !youRoundsDoneRef.current.has(round)) {
          youRoundsDoneRef.current.add(round);
          setScoreboard((prev) => ({
            ...prev,
            youWords: prev.youWords + (payload.won ? 1 : 0),
            youAttempts: prev.youAttempts + used,
          }));
        }

        if (roundDone) {
          if (matchDone) {
            setYouDone(true);
            setBanner({
              kind: "info",
              text: "Voce concluiu todas as rodadas. Aguardando resultado final...",
            });
          } else {
            setBanner({
              kind: "info",
              text: `Rodada ${round} concluida. Preparando rodada ${nextRound}...`,
            });

            if (ownRoundTimeoutRef.current) {
              clearTimeout(ownRoundTimeoutRef.current);
            }

            ownRoundTimeoutRef.current = setTimeout(() => {
              resetOwnRoundState(maxAttempts, wordLength);
              setCurrentRound(nextRound);
            }, 620);
          }
        }

        return;
      }

      if (type === "opponent_progress") {
        const progressOpponents = extractOpponentsFromPayload(
          payload,
          youId,
          you || playerName,
        );

        let targetOpponent = progressOpponents[0];
        if (!targetOpponent && opponents.length === 1) {
          targetOpponent = opponents[0];
        }

        if (!targetOpponent) {
          return;
        }

        const opponentId = targetOpponent.id;
        const opponentName = targetOpponent.name;

        upsertOpponent(targetOpponent);

        const used = Number(payload.attemptsUsed ?? 0);
        const left = Number(payload.attemptsLeft ?? maxAttempts - used);
        const round = Number(payload.round ?? 1);
        const roundDone = Boolean(payload.roundDone);
        const roundWon = Boolean(payload.won);
        const nextRound = Number(payload.nextRound ?? round + 1);

        const normalizedFeedback = Array.isArray(payload.feedback)
          ? normalizeFeedback(payload.feedback, wordLength)
          : null;
        const rowIndex = Number(payload.attemptIndex ?? used - 1);

        setOpponentBoards((prev) => {
          const current =
            prev[opponentId] ||
            createOpponentBoardState(maxAttempts, wordLength, round);

          let nextBoard = current;

          if (round !== current.round && !roundDone) {
            nextBoard = createOpponentBoardState(
              maxAttempts,
              wordLength,
              round,
            );
          }

          const updated = {
            ...nextBoard,
            attemptsUsed: used,
            attemptsLeft: left,
            done: Boolean(payload.done),
            round: roundDone && !payload.done ? nextRound : round,
          };

          if (normalizedFeedback) {
            const rows = updated.feedbackRows.map((row) => [...row]);
            if (rowIndex >= 0 && rowIndex < rows.length) {
              rows[rowIndex] = normalizedFeedback.slice(0, wordLength);
            }
            updated.feedbackRows = rows;
          }

          return {
            ...prev,
            [opponentId]: updated,
          };
        });

        if (normalizedFeedback && rowIndex >= 0 && rowIndex < maxAttempts) {
          triggerOpponentReveal(opponentId, rowIndex);
        }

        if (roundDone) {
          const doneKey = `${opponentId}:${round}`;
          if (!opponentRoundsDoneRef.current.has(doneKey)) {
            opponentRoundsDoneRef.current.add(doneKey);
            setScoreboard((prev) => ({
              ...prev,
              opponentWords: prev.opponentWords + (roundWon ? 1 : 0),
              opponentAttempts: prev.opponentAttempts + used,
            }));
          }

          if (roundWon) {
            showOpponentRoundWinPopup(opponentName);
          }
        }

        const displayRound = roundDone && !payload.done ? nextRound : round;
        upsertOpponent({
          id: opponentId,
          name: opponentName,
          currentRound: displayRound,
        });

        if (roundDone && !payload.done) {
          const existingTimeout = opponentRoundTimeoutsRef.current[opponentId];
          if (existingTimeout) {
            clearTimeout(existingTimeout);
          }

          opponentRoundTimeoutsRef.current[opponentId] = setTimeout(() => {
            setOpponentBoards((prev) => {
              if (!prev[opponentId]) {
                return prev;
              }

              return {
                ...prev,
                [opponentId]: createOpponentBoardState(
                  maxAttempts,
                  wordLength,
                  nextRound,
                ),
              };
            });

            delete opponentRoundTimeoutsRef.current[opponentId];
          }, 620);
        }

        return;
      }

      if (type === "game_over") {
        setGameOver(payload);
        setPhase(PHASE.FINISHED);
        setYouDone(true);
        setScoreboard({
          youWords: Number(payload?.you?.wordsGuessed ?? 0),
          opponentWords: Number(payload?.opponent?.wordsGuessed ?? 0),
          youAttempts: Number(payload?.you?.attempts ?? 0),
          opponentAttempts: Number(payload?.opponent?.attempts ?? 0),
        });

        const youWon = Boolean(payload?.you?.won);
        setBanner({
          kind: youWon ? "success" : "warning",
          text: youWon ? "Vitoria confirmada." : "Derrota confirmada.",
        });
        return;
      }

      if (type === "opponent_left") {
        for (const id of opponents.map((item) => item.id)) {
          clearOpponentTimersById(id);
        }

        setOpponents([]);
        setOpponentBoards({});
        setBanner({
          kind: "warning",
          text: payload.message || "Oponente saiu da sala.",
        });
        setActiveCount(1);
        setRoomStatus("waiting");
        if (phase !== PHASE.FINISHED) {
          setPhase(PHASE.WAITING);
        }
        return;
      }

      if (type === "error") {
        pushToast("error", payload.message || "Erro no servidor.");
      }
    };
  }

  function validateName() {
    const trimmed = playerName.trim();
    if (trimmed.length < 2) {
      pushToast("error", "Informe um nome com pelo menos 2 caracteres.");
      return false;
    }

    return true;
  }

  function handleCreateRoom() {
    if (!validateName()) {
      return;
    }

    const rounds = Number(roundsToPlay);

    resetMatchState({
      maxAttempts,
      wordLength,
      rounds,
    });

    connectIfNeeded();

    const action = () =>
      send("create_room", {
        playerName: playerName.trim(),
        rounds,
      });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      action();
    } else {
      wsRef.current?.addEventListener("open", action, { once: true });
    }
  }

  function handleJoinRoom() {
    if (!validateName()) {
      return;
    }

    const targetRoom = joinRoomId.trim().toUpperCase();
    if (!targetRoom) {
      pushToast("error", "Informe o codigo da sala.");
      return;
    }

    resetMatchState();
    connectIfNeeded();

    const action = () =>
      send("join_room", {
        roomId: targetRoom,
        playerName: playerName.trim(),
      });

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      action();
    } else {
      wsRef.current?.addEventListener("open", action, { once: true });
    }
  }

  function goToRoomOptions() {
    if (!validateName()) {
      return;
    }

    setPlayerName((prev) => prev.trim());
    setLobbyStep(LOBBY_STEP.ROOM);
  }

  const canType =
    phase === PHASE.PLAYING && !youDone && !gameOver && matchCountdown === null;

  function submitCurrentGuess() {
    if (!canType) {
      return;
    }

    const hasEmptySlot = draftLetters.some((letter) => !letter);
    if (hasEmptySlot) {
      pushToast("error", `Preencha as ${wordLength} posicoes antes de enviar.`);
      return;
    }

    const word = draftLetters.join("").toUpperCase();
    if (word.length !== wordLength) {
      pushToast("error", `O palpite deve ter ${wordLength} letras.`);
      return;
    }

    send("guess", {
      roomId,
      word,
    });
  }

  function findNextCursor(draft, startIndex) {
    for (let i = startIndex + 1; i < draft.length; i += 1) {
      if (!draft[i]) {
        return i;
      }
    }

    return Math.min(startIndex + 1, draft.length - 1);
  }

  function appendLetter(letter) {
    if (!letter || !/^[A-Z]$/.test(letter) || !canType) {
      return;
    }

    const next = [...draftRef.current];
    next[cursorIndex] = letter;
    setDraftLetters(next);
    setCursorIndex(findNextCursor(next, cursorIndex));
  }

  function removeLetter() {
    if (!canType) {
      return;
    }

    const next = [...draftRef.current];

    if (next[cursorIndex]) {
      next[cursorIndex] = "";
      setDraftLetters(next);
      return;
    }

    const previous = Math.max(0, cursorIndex - 1);
    next[previous] = "";
    setDraftLetters(next);
    setCursorIndex(previous);
  }

  function moveCursor(direction) {
    if (!canType) {
      return;
    }

    setCursorIndex((prev) => {
      if (direction === "left") {
        return Math.max(0, prev - 1);
      }

      return Math.min(wordLength - 1, prev + 1);
    });
  }

  function onKeyboardAction(value) {
    if (value === "ENTER") {
      submitCurrentGuess();
      return;
    }

    if (value === "BACKSPACE") {
      removeLetter();
      return;
    }

    appendLetter(value);
  }

  function handleStartGame() {
    if (!roomId || !canStartMatch) {
      return;
    }

    send("start_game", { roomId });
  }

  function handleLeaveRoom() {
    closeSocket(true);
    clearTimers();

    setPhase(PHASE.LOBBY);
    setLobbyStep(LOBBY_STEP.ROOM);
    setRoomId("");
    setJoinRoomId("");
    setYou("");
    setYouId("");
    setOwnerId("");
    setActiveCount(1);
    setRoomStatus("waiting");
    setOpponents([]);
    setOpponentBoards({});
    setBanner({ kind: "info", text: "Voce saiu da sala." });
    setConnectionStatus("offline");

    resetMatchState({
      maxAttempts,
      wordLength,
      rounds: 1,
    });
  }

  useEffect(() => {
    return () => {
      clearTimers();
      closeSocket(false);
    };
  }, []);

  useEffect(() => {
    const onPointerDown = (event) => {
      if (
        roundsPickerRef.current &&
        !roundsPickerRef.current.contains(event.target)
      ) {
        setIsRoundsMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, []);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (!canType) {
        return;
      }

      const activeTag = document.activeElement?.tagName;
      if (
        activeTag === "INPUT" ||
        activeTag === "TEXTAREA" ||
        activeTag === "SELECT"
      ) {
        return;
      }

      const key = event.key.toUpperCase();

      if (/^[A-Z]$/.test(key)) {
        event.preventDefault();
        appendLetter(key);
        return;
      }

      if (key === "BACKSPACE") {
        event.preventDefault();
        removeLetter();
        return;
      }

      if (key === "ARROWLEFT") {
        event.preventDefault();
        moveCursor("left");
        return;
      }

      if (key === "ARROWRIGHT") {
        event.preventDefault();
        moveCursor("right");
        return;
      }

      if (key === "ENTER") {
        event.preventDefault();
        submitCurrentGuess();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canType, cursorIndex, draftLetters, roomId, youDone, gameOver]);

  const primaryOpponentName = visibleOpponents[0]?.name || "";
  const winnerText = getWinnerText(gameOver, you, primaryOpponentName);
  const reasonText = getReasonText(gameOver?.matchSummary?.reason);
  const roundRows = buildRoundRows(gameOver);

  return (
    <div className="app-shell">
      <main className="page">
        <header className="topbar reveal-up">
          <div className="left-meta" />
          <h1>TERMO</h1>
          <div className="right-meta">
            <span className="room-pill">{roomId || "LOBBY"}</span>
          </div>
        </header>

        {banner ? (
          <section className={`banner ${banner.kind}`}>
            <p>{banner.text}</p>
          </section>
        ) : null}

        {phase === PHASE.LOBBY ? (
          <section
            className={`lobby-grid reveal-up delay-1 ${
              lobbyStep === LOBBY_STEP.NAME ? "single" : "dual"
            }`}
          >
            {lobbyStep === LOBBY_STEP.NAME ? (
              <article className="panel">
                <h2>Qual e seu nome?</h2>
                <label htmlFor="playerName">Seu nome</label>
                <input
                  id="playerName"
                  value={playerName}
                  onChange={(event) => setPlayerName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      goToRoomOptions();
                    }
                  }}
                  placeholder="Ex: Jose"
                  maxLength={20}
                  autoComplete="off"
                />

                <div className="action-row">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={goToRoomOptions}
                  >
                    Continuar
                  </button>
                </div>
              </article>
            ) : (
              <>
                <article className="panel">
                  <h2>Entrar no duelo</h2>
                  <p className="lobby-name">Jogando como {playerName}</p>

                  <label htmlFor="roundsSelectButton">Rodadas</label>
                  <div className="rounds-picker" ref={roundsPickerRef}>
                    <button
                      id="roundsSelectButton"
                      type="button"
                      className="rounds-trigger"
                      aria-haspopup="listbox"
                      aria-expanded={isRoundsMenuOpen}
                      onClick={() => setIsRoundsMenuOpen((prev) => !prev)}
                    >
                      <span>{roundsToPlay}</span>
                      <span className="rounds-arrow" aria-hidden="true">
                        {isRoundsMenuOpen ? "▲" : "▼"}
                      </span>
                    </button>

                    {isRoundsMenuOpen ? (
                      <div className="rounds-menu" role="listbox">
                        {ROUND_OPTIONS.map((roundOption) => {
                          const value = String(roundOption);
                          const isSelected = roundsToPlay === value;

                          return (
                            <button
                              type="button"
                              key={`round-${roundOption}`}
                              className={`rounds-option ${
                                isSelected ? "selected" : ""
                              }`}
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => {
                                setRoundsToPlay(value);
                                setIsRoundsMenuOpen(false);
                              }}
                            >
                              {value}
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="action-row">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={handleCreateRoom}
                    >
                      Criar sala
                    </button>
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={() => setLobbyStep(LOBBY_STEP.NAME)}
                    >
                      Trocar nome
                    </button>
                  </div>
                </article>

                <article className="panel">
                  <h2>Entrar em uma sala</h2>
                  <label htmlFor="roomId">Codigo da sala</label>
                  <input
                    id="roomId"
                    value={joinRoomId}
                    onChange={(event) =>
                      setJoinRoomId(event.target.value.toUpperCase())
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        handleJoinRoom();
                      }
                    }}
                    placeholder="Ex: AB12CD"
                    maxLength={16}
                    autoComplete="off"
                  />

                  <div className="action-row">
                    <button
                      type="button"
                      className="btn btn-outline"
                      onClick={handleJoinRoom}
                    >
                      Entrar na sala
                    </button>
                  </div>
                </article>
              </>
            )}
          </section>
        ) : null}

        {phase !== PHASE.LOBBY ? (
          <section
            className="match-layout reveal-up delay-1"
            style={{ gridTemplateColumns: "1fr" }}
          >
            <article className="game-main">
              <div
                className="panel"
                style={{
                  gridColumn: "1 / -1",
                  width: "100%",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.75rem",
                  flexWrap: "wrap",
                }}
              >
                <p style={{ margin: 0 }}>
                  Rodada {currentRound}/{totalRounds} | Placar{" "}
                  {scoreboard.youWords} x {scoreboard.opponentWords} |
                  Tentativas {scoreboard.youAttempts} x{" "}
                  {scoreboard.opponentAttempts}
                </p>
                <div
                  style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
                >
                  {phase === PHASE.WAITING ? (
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ width: "auto", marginTop: 0 }}
                      onClick={handleStartGame}
                      disabled={!canStartMatch}
                    >
                      Comecar partida
                    </button>
                  ) : null}

                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ width: "auto", marginTop: 0 }}
                    onClick={handleLeaveRoom}
                  >
                    Sair da sala
                  </button>
                </div>
              </div>

              <div className="main-board-wrap" aria-label="Seu tabuleiro">
                <div className="board" style={{ "--cols": wordLength }}>
                  {boardRows.map((row, rowIndex) => (
                    <div className="board-row" key={`row-${rowIndex}`}>
                      {Array.from({ length: wordLength }).map((_, colIndex) => {
                        const letter = Array.isArray(row.word)
                          ? row.word[colIndex] || ""
                          : row.word[colIndex] || "";
                        const status = row.feedback[colIndex] || "empty";
                        const isInputRow =
                          rowIndex === guesses.length && canType;
                        const isCursor = isInputRow && colIndex === cursorIndex;
                        const shouldFlip =
                          revealState.rowIndex === rowIndex &&
                          status !== "empty" &&
                          letter;

                        return (
                          <div
                            key={`cell-${rowIndex}-${colIndex}`}
                            className={`cell ${status} ${letter ? "filled" : ""} ${
                              isCursor ? "cursor-active" : ""
                            } ${shouldFlip ? "flip" : ""}`}
                            style={{ "--flip-index": colIndex }}
                            onClick={() => {
                              if (isInputRow) {
                                setCursorIndex(colIndex);
                              }
                            }}
                          >
                            {letter}
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>

              <section
                className="opponent-panel"
                aria-label="Progresso dos oponentes"
              >
                <h3>Oponentes</h3>

                {visibleOpponents.length === 0 ? (
                  <p className="mini-caption">
                    {activeCount >= 2
                      ? "Aguardando inicio do dono da sala..."
                      : "Aguardando jogadores..."}
                  </p>
                ) : (
                  <div
                    style={{
                      display: "grid",
                      gap: "0.55rem",
                    }}
                  >
                    {visibleOpponents.map((item) => {
                      const board =
                        opponentBoards[item.id] ||
                        createOpponentBoardState(
                          maxAttempts,
                          wordLength,
                          Number(item.currentRound ?? 1),
                        );

                      return (
                        <div
                          key={item.id}
                          style={{
                            padding: "0.4rem",
                            border: "1px solid rgba(255,255,255,0.12)",
                            borderRadius: "8px",
                            background: "rgba(0,0,0,0.12)",
                          }}
                        >
                          <p
                            className="mini-caption"
                            style={{ marginTop: 0, marginBottom: "0.35rem" }}
                          >
                            {item.name}
                          </p>

                          <div
                            className="mini-board"
                            style={{ "--cols": wordLength }}
                          >
                            {board.feedbackRows.map((row, rowIndex) => (
                              <div
                                className="board-row"
                                key={`${item.id}-${rowIndex}`}
                              >
                                {row.map((status, colIndex) => {
                                  const shouldMiniFlip =
                                    board.revealState.rowIndex === rowIndex &&
                                    status !== "empty";

                                  return (
                                    <div
                                      key={`${item.id}-${rowIndex}-${colIndex}`}
                                      className={`mini-cell ${status} ${
                                        shouldMiniFlip ? "flip" : ""
                                      }`}
                                      style={{ "--mini-flip-index": colIndex }}
                                    />
                                  );
                                })}
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              <div className="keyboard" aria-label="Teclado virtual">
                {KEYBOARD_ROWS.map((row, rowIndex) => (
                  <div className="keyboard-row" key={`kb-row-${rowIndex}`}>
                    {row.split("").map((letter) => (
                      <button
                        type="button"
                        key={letter}
                        className={`key ${keyboardStateMap[letter] || ""}`}
                        onClick={() => onKeyboardAction(letter)}
                        disabled={!canType}
                      >
                        {letter}
                      </button>
                    ))}

                    {rowIndex === KEYBOARD_ROWS.length - 1 ? (
                      <>
                        <button
                          type="button"
                          className="key key-action"
                          onClick={() => onKeyboardAction("BACKSPACE")}
                          disabled={!canType}
                        >
                          APAGAR
                        </button>
                        <button
                          type="button"
                          className="key key-action"
                          onClick={() => onKeyboardAction("ENTER")}
                          disabled={!canType}
                        >
                          ENTER
                        </button>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>

              <p className="hint-line">
                {phase === PHASE.WAITING
                  ? isOwner
                    ? activeCount >= 2
                      ? "Quando quiser, clique em Comecar partida para sincronizar todo mundo."
                      : "Aguardando pelo menos 2 jogadores para liberar o inicio."
                    : activeCount >= 2
                      ? "Aguardando o dono da sala iniciar a partida."
                      : "Aguardando mais jogadores entrarem na sala."
                  : "Clique na posicao desejada para escrever fora de ordem. Setas esquerda/direita tambem movem o cursor."}
              </p>
            </article>
          </section>
        ) : null}

        {phase === PHASE.PLAYING && youDone && !gameOver ? (
          <section
            className="panel round-waiting reveal-up delay-2"
            role="status"
            aria-live="polite"
          >
            <h2>Rodada concluida</h2>
            <p className="waiting-text">
              Voce terminou todas as rodadas. Aguardando oponente finalizar...
            </p>
          </section>
        ) : null}

        {phase === PHASE.FINISHED && gameOver ? (
          <section className="panel final-result round-comparison reveal-up delay-2">
            <h2>Resultado final</h2>
            <p className="result-headline">{winnerText}</p>
            <p className="result-reason">{reasonText}</p>
            <p>
              Rodadas: {gameOver?.you?.roundsFinished ?? 0}/
              {gameOver?.matchSummary?.totalRounds ?? totalRounds} x{" "}
              {gameOver?.opponent?.roundsFinished ?? 0}/
              {gameOver?.matchSummary?.totalRounds ?? totalRounds}
            </p>
            <p>
              Tentativas totais: {gameOver?.you?.attempts ?? "-"} x{" "}
              {gameOver?.opponent?.attempts ?? "-"}
            </p>

            <h3 className="rounds-heading">Comparacao por rodada</h3>
            <ol
              className="round-result-list"
              aria-label="Comparacao por rodada"
            >
              {roundRows.map((roundItem) => {
                const youStatus = getRoundStatus(roundItem.you);
                const opponentStatus = getRoundStatus(roundItem.opponent);

                return (
                  <li
                    key={`round-summary-${roundItem.round}`}
                    className="round-result-item"
                  >
                    <span className="round-index">R{roundItem.round}</span>

                    <div className="round-word">
                      <span className="label">Palavra</span>
                      <strong>{roundItem.word}</strong>
                    </div>

                    <div className="round-side">
                      <span className={`status-pill ${youStatus.tone}`}>
                        Voce: {youStatus.text}
                      </span>
                      <span className="attempts">{youStatus.attemptsText}</span>
                    </div>

                    <div className="round-side">
                      <span className={`status-pill ${opponentStatus.tone}`}>
                        Oponente: {opponentStatus.text}
                      </span>
                      <span className="attempts">
                        {opponentStatus.attemptsText}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>

            {roundRows.length === 0 ? (
              <p className="waiting-text">Sem dados por rodada disponiveis.</p>
            ) : null}
          </section>
        ) : null}
      </main>

      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.type}`}>
            {toast.text}
          </div>
        ))}
      </div>

      {opponentRoundWinPopup ? (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "fixed",
            top: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            zIndex: 40,
            padding: "0.45rem 0.75rem",
            borderRadius: "8px",
            background: "rgba(46, 132, 64, 0.92)",
            border: "1px solid rgba(140, 230, 160, 0.7)",
            color: "#f3fff5",
            fontSize: "0.85rem",
            fontWeight: 700,
          }}
        >
          {opponentRoundWinPopup}
        </div>
      ) : null}

      {matchCountdown !== null ? (
        <div className="countdown-overlay" aria-live="assertive" role="status">
          <div key={matchCountdown} className="countdown-number">
            {matchCountdown}
          </div>
          <p className="countdown-caption">Partida iniciando...</p>
        </div>
      ) : null}
    </div>
  );
}

export default App;
