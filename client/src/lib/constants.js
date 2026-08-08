const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const isLocalhost = ["localhost", "127.0.0.1"].includes(
  window.location.hostname,
);
const isLikelyFrontendPort = ["5173", "8080", "4173"].includes(
  window.location.port,
);
const fallbackPort =
  isLocalhost && isLikelyFrontendPort ? "3000" : window.location.port;
const fallbackHost = fallbackPort
  ? `${window.location.hostname}:${fallbackPort}`
  : window.location.hostname;
const defaultHost = `${protocol}://${fallbackHost || "localhost:3000"}`;

export const WS_URL = import.meta.env.VITE_WS_URL || defaultHost;
export const DEFAULT_WORD_LENGTH = 5;
export const DEFAULT_MAX_ATTEMPTS = 6;
