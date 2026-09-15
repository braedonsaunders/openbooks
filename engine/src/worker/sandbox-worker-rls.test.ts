import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./sandbox-worker.ts", import.meta.url),
  "utf8",
);

test("sandbox jobs execute inside an explicit trusted boundary", () => {
  // Sandbox operations span two tenants (production source + sandbox clone),
  // so the payload processor must cross a trusted boundary: a queue callback
  // carries no request store, and without it the deny-by-default GUCs make
  // every entry read return zero rows (creates/refreshes throw not-found,
  // deletes silently no-op).
  const processor = source.slice(
    source.indexOf("export async function processSandboxJobData"),
    source.indexOf("export function createSandboxWorker"),
  );
  assert.match(processor, /withBypassContext\(async \(\) => \{/);
});

test("the sandbox worker callback delegates to the bounded payload processor", () => {
  const worker = source.slice(source.indexOf("export function createSandboxWorker"));
  assert.match(worker, /processSandboxJobData\(job\.data\)/);
  assert.doesNotMatch(worker, /createSandbox\(|refreshSandbox\(|resetSandbox\(|deleteSandbox\(/);
});
