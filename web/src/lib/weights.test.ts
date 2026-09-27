import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWeightDelta, clampWeight, WEIGHT_MIN, WEIGHT_MAX } from "./weights.js";

test("sin feedback previo, like suma un paso", () => {
  assert.equal(computeWeightDelta(null, true), 0.15);
});

test("sin feedback previo, dislike resta un paso", () => {
  assert.equal(computeWeightDelta(null, false), -0.15);
});

test("pasar de like a dislike aplica el delta neto (revierte + aplica)", () => {
  assert.equal(computeWeightDelta(true, false), -0.30);
});

test("pasar de dislike a like aplica el delta neto", () => {
  assert.equal(computeWeightDelta(false, true), 0.30);
});

test("click repetido sobre el mismo valor es un no-op", () => {
  assert.equal(computeWeightDelta(true, true), 0);
  assert.equal(computeWeightDelta(false, false), 0);
});

test("clampWeight respeta el piso y el techo", () => {
  assert.equal(clampWeight(0.1), WEIGHT_MIN);
  assert.equal(clampWeight(5), WEIGHT_MAX);
  assert.equal(clampWeight(1.5), 1.5);
});
