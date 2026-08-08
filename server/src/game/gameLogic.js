import { WORDS } from "./wordList.js";

export const WORD_LENGTH = 5;
export const MAX_ATTEMPTS = 6;

export function normalizeWord(value) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z]/g, "")
    .toUpperCase();
}

export function isValidGuess(word) {
  const normalized = normalizeWord(word);
  return normalized.length === WORD_LENGTH;
}

export function pickSecretWord() {
  const idx = Math.floor(Math.random() * WORDS.length);
  return WORDS[idx];
}

export function evaluateGuess(guess, secretWord) {
  const normalizedGuess = normalizeWord(guess);
  const normalizedSecret = normalizeWord(secretWord);

  const feedback = Array(WORD_LENGTH).fill("gray");
  const secretChars = normalizedSecret.split("");
  const guessChars = normalizedGuess.split("");

  for (let i = 0; i < WORD_LENGTH; i += 1) {
    if (guessChars[i] === secretChars[i]) {
      feedback[i] = "green";
      secretChars[i] = null;
      guessChars[i] = null;
    }
  }

  for (let i = 0; i < WORD_LENGTH; i += 1) {
    if (!guessChars[i]) {
      continue;
    }

    const letterPos = secretChars.indexOf(guessChars[i]);
    if (letterPos !== -1) {
      feedback[i] = "yellow";
      secretChars[letterPos] = null;
    }
  }

  return feedback;
}

export function didWin(feedback) {
  return feedback.every((slot) => slot === "green");
}
