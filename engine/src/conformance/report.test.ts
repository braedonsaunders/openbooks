import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { renderJson } from "./report.ts";
import { renderControlsJson } from "./controls.ts";
import type { CorpusReport } from "./types.ts";

const report = {
  at: "2026-09-16T00:00:00.000Z",
  gitSha: "abc123",
  runId: "999",
  results: [],
  totals: { pass: 0, fail: 0, gap: 1, skipped: 0 },
  pass: true,
} as unknown as CorpusReport;

test("rendered conformance JSON carries verifiable provenance", () => {
  const parsed = JSON.parse(renderJson(report));
  assert.equal(parsed.gitSha, "abc123");
  assert.equal(parsed.runId, "999");
  assert.equal(
    parsed.casesSha256,
    createHash("sha256").update(JSON.stringify(parsed.cases)).digest("hex"),
    "the embedded digest must recompute over the serialized cases",
  );
});

test("rendered controls JSON carries verifiable provenance", () => {
  const parsed = JSON.parse(renderControlsJson(report as never));
  assert.equal(parsed.kind, "internal-controls");
  assert.equal(parsed.gitSha, "abc123");
  assert.equal(parsed.runId, "999");
  assert.equal(
    parsed.casesSha256,
    createHash("sha256").update(JSON.stringify(parsed.cases)).digest("hex"),
    "the embedded digest must recompute over the serialized cases",
  );
});
