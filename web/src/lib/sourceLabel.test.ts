import { test } from "node:test";
import assert from "node:assert/strict";
import { getSourceLabel } from "./sourceLabel.js";

test("usa el nombre de la fuente cuando existe", () => {
  assert.equal(
    getSourceLabel({ source: { name: "Infobae Economía" }, url: "https://infobae.com/x" }),
    "Infobae Economía"
  );
});

test("cae al hostname (sin www.) cuando no hay fuente asociada", () => {
  assert.equal(
    getSourceLabel({ source: null, url: "https://www.clarin.com/nota" }),
    "clarin.com"
  );
});
