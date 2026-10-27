import assert from "node:assert/strict";
import test from "node:test";
import { queuedSandboxRows } from "./queued-rows";
import type { SandboxRow } from "./SandboxManager";

const row = (name: string, status: string): SandboxRow => ({
  id: `row-${name}`,
  orgId: `org-${name}`,
  name,
  tier: "full",
  masked: false,
  status,
  lastError: null,
  lastRefreshAt: null,
  refreshSchedule: null,
  storageRows: 10,
  createdAt: "2026-10-27T14:00:00.000Z",
});

test("a queued create is listed before the worker writes its sandbox row", () => {
  const rows = queuedSandboxRows(
    [
      {
        jobId: "sbx|create|a",
        name: "QA",
        tier: "masked",
        masked: true,
        queuedAt: "2026-10-27T15:00:00.000Z",
        state: "queued",
      },
    ],
    [row("Existing", "ready")],
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "queued");
  assert.equal(rows[0]!.name, "QA");
  assert.equal(rows[0]!.id, "queued:sbx|create|a");
});

test("a running create is shown once its provisioning row exists", () => {
  const job = {
    jobId: "sbx|create|b",
    name: "QA",
    tier: "full" as const,
    masked: false,
    queuedAt: "2026-10-27T15:00:00.000Z",
    state: "active" as const,
  };
  assert.deepEqual(queuedSandboxRows([job], [row("QA", "provisioning")]), []);
  const beforeRow = queuedSandboxRows([job], []);
  assert.equal(beforeRow.length, 1);
  assert.equal(beforeRow[0]!.status, "provisioning");
  // A failed earlier attempt with the same name does not hide the new run.
  assert.equal(queuedSandboxRows([job], [row("QA", "failed")]).length, 1);
});
