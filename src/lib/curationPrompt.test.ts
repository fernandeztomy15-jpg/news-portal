import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTopicPickPrompt, buildScoringPrompt } from "./curationPrompt.js";

test("el prompt de tema incluye los temas recientes a evitar", () => {
  const prompt = buildTopicPickPrompt(["historia", "espacio"]);
  assert.match(prompt, /historia/);
  assert.match(prompt, /espacio/);
});

test("el prompt de scoring instruye ignorar pesos para descubrimiento", () => {
  const prompt = buildScoringPrompt({
    weights: { macro: 1.2 },
    likedTitles: ["Suba de tasas en EE.UU."],
    dislikedTitles: [],
    candidates: [
      { id: "a1", title: "Nota de mercado", summary: null, category: "mercado" },
      { id: "d1", title: "Nota de descubrimiento", summary: null, category: "descubrimiento" },
    ],
  });
  assert.match(prompt, /descubrimiento/i);
  assert.match(prompt, /ignor/i); // instrucción de ignorar pesos en descubrimiento
  assert.match(prompt, /"a1"/);
  assert.match(prompt, /"d1"/);
});

test("el prompt de scoring incluye los pesos de categoría", () => {
  const prompt = buildScoringPrompt({
    weights: { macro: 1.45 },
    likedTitles: [],
    dislikedTitles: [],
    candidates: [],
  });
  assert.match(prompt, /1\.45/);
});
