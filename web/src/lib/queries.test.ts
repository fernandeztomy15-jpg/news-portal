import { test } from "node:test";
import assert from "node:assert/strict";
import { groupArticlesByCategory, getDigestWindowStart, CATEGORY_ORDER, type ArticleRow } from "./queries.js";

function article(overrides: Partial<ArticleRow>): ArticleRow {
  return {
    id: "1", title: "t", url: "https://x.com", category: "macro",
    score: 50, reason: "r", liked: null, curated_at: "2026-09-27T00:00:00Z",
    source: null, ...overrides,
  };
}

test("agrupa por categoría en el orden fijo, incluyendo categorías vacías", () => {
  const grouped = groupArticlesByCategory([article({ category: "deportes" })]);
  assert.deepEqual([...grouped.keys()], CATEGORY_ORDER);
  assert.equal(grouped.get("macro")!.length, 0);
  assert.equal(grouped.get("deportes")!.length, 1);
});

test("getDigestWindowStart resta 48 horas", () => {
  const now = new Date("2026-09-27T12:00:00Z");
  const start = getDigestWindowStart(now);
  assert.equal(start.toISOString(), "2026-09-25T12:00:00.000Z");
});
