import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("assistant journal creation does not persist a header before its lines", () => {
  assert.doesNotMatch(source, /createDraftJournal\(/);
  assert.match(source, /executeIdempotent\([\s\S]*?db\.transaction\(async \(tx\)/);
  assert.match(source, /allocateDocumentNumber\(tx[\s\S]*?insert into documents[\s\S]*?insert into document_lines/);
});

test("assistant journal failures remain retryable through the same confirmation claim", () => {
  assert.match(source, /idempotencyKey:\s*body\.confirmToken/);
  assert.match(source, /return NextResponse\.json\(result\.value\)/);
});
