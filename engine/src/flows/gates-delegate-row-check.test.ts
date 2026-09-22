import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "gates.ts"), "utf8");
const start = source.indexOf("export async function delegateGate");
const end = source.indexOf("// --- Timers:");
const body = source.slice(start, end);

test("delegateGate checks the status-predicated UPDATE row count before notify/audit", () => {
  assert.ok(start > 0 && end > start, "delegateGate body must be locatable");
  const returning = body.indexOf(".returning");
  const zeroCheck = body.search(/delegated\.length === 0/);
  const notify = body.indexOf("schema.notifications");
  const audit = body.indexOf("insert into audit_log");
  assert.ok(returning > 0, "the pending UPDATE must return matched rows");
  assert.ok(zeroCheck > returning, "zero matched rows must be a named failure");
  assert.match(body.slice(zeroCheck, zeroCheck + 180), /already resolved/);
  assert.ok(notify > zeroCheck && audit > zeroCheck, "notify/audit must not run after a zero-row flip");
  assert.match(body, /pg_advisory_xact_lock\(hashtext\(\$\{gate\.runId\}\)/);
});
