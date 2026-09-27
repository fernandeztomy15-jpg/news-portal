import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGoogleNewsRssUrl } from "./googleNews.js";

test("codifica la query y usa español/AR como idioma", () => {
  const url = buildGoogleNewsRssUrl("dólar bonos acciones");
  assert.equal(
    url,
    "https://news.google.com/rss/search?q=d%C3%B3lar%20bonos%20acciones&hl=es-419"
  );
});

test("query vacía sigue produciendo una URL válida", () => {
  const url = buildGoogleNewsRssUrl("");
  assert.ok(url.startsWith("https://news.google.com/rss/search?q=&hl=es-419"));
});
