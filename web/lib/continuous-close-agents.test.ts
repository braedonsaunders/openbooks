import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const lib = read("./continuous-close.ts");
const tools = read("./assistant/tools.ts");
// Pack keys from the WORKTREE engine source (not the linked package, which
// tracks main and may know packs this worktree does not yet).
const engineSource = read("../../engine/src/continuous-close-config.ts");
const keyBlock = engineSource.slice(
  engineSource.indexOf("CONTINUOUS_CLOSE_AGENT_KEYS = ["),
  engineSource.indexOf("] as const"),
);
const CONTINUOUS_CLOSE_AGENT_KEYS = [...keyBlock.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string);

// Agent visibility must follow the engine pack registry (b02: six packs and
// growing), never a hardcoded accounting|finance pair — otherwise new packs
// are invisible to the workbench, the routes, and the chat tools.
test("agent read access is registry-driven, not a hardcoded pair", () => {
  assert.match(lib, /CONTINUOUS_CLOSE_AGENT_KEYS/);
  assert.match(lib, /from "@openbooks\/engine\/src\/continuous-close-config\.ts"/);
  assert.doesNotMatch(lib, /\["accounting",\s*"finance"\]/);
  assert.match(lib, /export function canReadContinuousCloseAgent/);
  assert.match(lib, /export function readableContinuousCloseAgents/);
  assert.match(
    lib,
    /CONTINUOUS_CLOSE_AGENT_KEYS\.filter\(\(agent\) => canReadContinuousCloseAgent\(authz, agent\)\)/,
  );
});

// Unknown agent keys fail closed: a future pack (or a forged row) is never
// readable until the registry knows it — and a pack the linked engine knows
// but this revision's grant table does not is denied, never a crash.
test("unknown agent keys fail closed", () => {
  assert.match(lib, /\(CONTINUOUS_CLOSE_AGENT_KEYS as readonly string\[\]\)\.includes\(agentKey\)/);
  assert.match(lib, /if \(!perms\) return false/);
});

// Every registered pack declares the read grants that mirror the screen its
// detectors read. The table is keyed by the registry so the compiler refuses
// a pack without a gate.
test("every registered pack declares read grants", () => {
  assert.match(lib, /Record<ContinuousCloseAgentKey, readonly string\[\]>/);
  for (const key of CONTINUOUS_CLOSE_AGENT_KEYS) {
    assert.match(lib, new RegExp(`^  ${key}: \\[`, "m"), `${key} has no read-grant entry`);
  }
  // Packs mirror their screens: collections watches receivables, payables the
  // AP cockpit, reconciliation bank data, hygiene ledger/master-data quality.
  assert.match(lib, /collections: \["ar\.read"\]/);
  assert.match(lib, /payables: \["ap\.read"\]/);
  assert.match(lib, /reconciliation: \["banking\.read", "banking\.reconcile"\]/);
  // assistant.use stays the outer doorway for every pack.
  assert.match(lib, /if \(!can\(authz, "assistant\.use"\)\) return false/);
});

// Chat tools accept and enforce the same registry: the agent filter enum is
// the registry tuple, the doorway gate admits AR/AP readers, and the single-
// finding read checks the row's key against the caller's readable packs.
test("assistant finding tools follow the same registry", () => {
  assert.match(tools, /z\.enum\(CONTINUOUS_CLOSE_AGENT_KEYS\)/);
  assert.match(tools, /"ap\.read", "ar\.read"/);
  assert.match(
    tools,
    /!\(readableContinuousCloseAgents\(authz\) as readonly string\[\]\)\.includes\(row\.agent_key\)/,
  );
});
