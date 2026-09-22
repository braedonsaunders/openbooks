import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const SOURCE = readFileSync(new URL("./setup-read.ts", import.meta.url), "utf8");

test("getSetupRecord queries by primary key and names the list remedy", () => {
  const start = SOURCE.indexOf("export async function getSetupRecord");
  assert.ok(start >= 0);
  const next = SOURCE.indexOf("\nexport async function", start + 1);
  const body = SOURCE.slice(start, next === -1 ? undefined : next);
  assert.doesNotMatch(body, /listSetupRecords/);
  assert.match(body, /where \$\{sql\.raw\(idColumn\)\} = \$\{input\.id\}/);
  assert.match(body, /setupRecordMissing\(entity\.key\)/);
  assert.match(body, /rows\.rows\.length !== 1/);
  assert.match(SOURCE, /list ids from GET \/api\/v1\/setup\/\$\{entityKey\}/);
});

test("unknown and feature-off setup entities name the catalog remedy", () => {
  assert.match(SOURCE, /list enabled entities from GET \/api\/v1\/setup/);
  assert.doesNotMatch(SOURCE, /throw notFound\("setup entity"\)/);
  assert.doesNotMatch(SOURCE, /throw notFound\("setup record"\)/);
});
