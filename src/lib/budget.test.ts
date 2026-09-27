import { test } from "node:test";
import assert from "node:assert/strict";
import { hasExceededBudget, MONTHLY_BUDGET_CAP_USD } from "./budget.js";

test("por debajo del tope no excede", () => {
  assert.equal(hasExceededBudget(4.99, 5), false);
});

test("exactamente en el tope sí excede (no llamar de nuevo)", () => {
  assert.equal(hasExceededBudget(5.0, 5), true);
});

test("por encima del tope excede", () => {
  assert.equal(hasExceededBudget(5.01, 5), true);
});

test("la constante del tope es 5", () => {
  assert.equal(MONTHLY_BUDGET_CAP_USD, 5);
});
