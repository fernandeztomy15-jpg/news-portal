import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd } from "./pricing.js";

test("calcula costo con precios de Haiku 4.5 ($1/$5 por millón)", () => {
  // 1,000,000 input + 1,000,000 output = $1 + $5 = $6
  assert.equal(estimateCostUsd(1_000_000, 1_000_000), 6);
});

test("volumen bajo típico de una corrida", () => {
  // 6500 input, 1800 output -> (6500/1e6)*1 + (1800/1e6)*5
  const result = estimateCostUsd(6500, 1800);
  assert.ok(Math.abs(result - 0.0155) < 0.0001);
});

test("cero tokens da costo cero", () => {
  assert.equal(estimateCostUsd(0, 0), 0);
});
