import assert from "node:assert/strict";
import test from "node:test";
import { evaluateGuess, isValidGuess } from "../src/game/gameLogic.js";

test("evaluateGuess marks exact matches as green", () => {
  const result = evaluateGuess("AMIGO", "AMIGO");
  assert.deepEqual(result, ["green", "green", "green", "green", "green"]);
});

test("evaluateGuess handles repeated letters with two-pass logic", () => {
  const result = evaluateGuess("ARARA", "AMORA");
  assert.deepEqual(result, ["green", "gray", "gray", "green", "green"]);
});

test("isValidGuess accepts any 5-letter word", () => {
  assert.equal(isValidGuess("XISTO"), true);
  assert.equal(isValidGuess("AAAAA"), true);
});

test("isValidGuess rejects words with invalid length", () => {
  assert.equal(isValidGuess("ABCD"), false);
  assert.equal(isValidGuess("ABCDEF"), false);
});
