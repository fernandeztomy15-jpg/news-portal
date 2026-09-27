import { test } from "node:test";
import assert from "node:assert/strict";
import { selectOverflowIds, MAX_ARTICLES_PER_CATEGORY } from "./categoryCap.js";

test("no hay overflow si hay menos filas que el máximo", () => {
  const rows = [
    { id: "a", score: 90 },
    { id: "b", score: 80 },
  ];
  assert.deepEqual(selectOverflowIds(rows, 8), []);
});

test("devuelve los ids de menor score cuando hay overflow", () => {
  const rows = [
    { id: "low1", score: 10 },
    { id: "high1", score: 90 },
    { id: "low2", score: 20 },
    { id: "high2", score: 80 },
  ];
  // max=2 -> se quedan high1 (90) y high2 (80), sobran low2 (20) y low1 (10)
  assert.deepEqual(selectOverflowIds(rows, 2), ["low2", "low1"]);
});

test("un score null se trata como el más bajo posible", () => {
  const rows = [
    { id: "sinScore", score: null },
    { id: "conScore", score: 5 },
  ];
  assert.deepEqual(selectOverflowIds(rows, 1), ["sinScore"]);
});

test("la constante del tope es 8", () => {
  assert.equal(MAX_ARTICLES_PER_CATEGORY, 8);
});
