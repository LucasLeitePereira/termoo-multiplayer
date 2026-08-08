const protocol = window.location.protocol === "https:" ? "wss" : "ws";
const defaultHost = `${protocol}://${window.location.hostname || "localhost"}:3000`;

export const WS_URL = import.meta.env.VITE_WS_URL || defaultHost;
export const DEFAULT_WORD_LENGTH = 5;
export const DEFAULT_MAX_ATTEMPTS = 6;
