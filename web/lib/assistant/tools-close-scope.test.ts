import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const close = read("./tools-close.ts");
const wizard = read("../../app/(app)/close/view.ts");

// The close cockpit (/close) requires close.read plus an org-wide scope
// (guardCloseScope 404s restricted-subsidiary callers; the runs API does the
// same). The assistant's close reads must match: close.read gate, org-wide
// scope required, never a per-subsidiary filter that would imply restricted
// callers can see close diagnostics.
test("close read tools match the cockpit gate and org-wide scope rule", () => {
  assert.match(close, /name: "get_close_run_status"/);
  assert.match(close, /name: "list_period_locks"/);
  assert.match(close, /name: "list_period_reopen_requests"/);
  assert.match(close, /gate: \{ mode: "anyOf", perms: \["close\.read"\] \}/);
  assert.match(close, /closeScopeDenied/);
  assert.match(close, /allowedSubsidiaryIds === null \? null : \{ ok: false, error: "forbidden" \}/);
});

test("close run status reuses the wizard's query shapes", () => {
  for (const table of ["close_runs", "close_run_tasks", "close_exceptions", "close_signoffs", "period_locks"]) {
    assert.ok(close.includes(table), `tools-close.ts must read ${table}`);
    assert.ok(wizard.includes(table), `wizard must read ${table} (reuse check)`);
  }
  assert.match(close, /\/close\?run=/);
});

test("period locks expose every lock dimension the set-lock action writes", () => {
  for (const column of ["subsidiary_id", "module", "state", "reopen_expires_at"]) {
    assert.ok(close.includes(column), `list_period_locks must expose ${column}`);
  }
  assert.match(close, /from period_locks/);
});

test("reopen-request reads stay inside the reopen workflow's permission boundary", () => {
  assert.match(close, /from close_reopen_requests/);
  // Request/decide live behind close.reopen (admin/close route) and the setup
  // surface behind periods.manage — the read side admits exactly those two.
  assert.match(close, /perms: \["close\.reopen", "periods\.manage"\]/);
  const reopenTool = close.slice(close.indexOf('name: "list_period_reopen_requests"'));
  assert.match(reopenTool, /closeScopeDenied\(authz\)/);
});
