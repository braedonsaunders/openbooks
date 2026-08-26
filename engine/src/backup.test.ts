import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  auditBackupEvent,
  backupFileBaseName,
  backupObjectKey,
  computeNextRunAt,
  purgeBackupRun,
} from "./backup.ts";
import { db } from "./db.ts";

const DAILY = { frequency: "daily", hourUtc: 2, dayOfWeek: 1, dayOfMonth: 1 } as const;
const WEEKLY = { frequency: "weekly", hourUtc: 3, dayOfWeek: 1, dayOfMonth: 1 } as const; // Mondays
const MONTHLY = { frequency: "monthly", hourUtc: 4, dayOfWeek: 1, dayOfMonth: 15 } as const;

test("daily: later today when the hour hasn't passed", () => {
  const from = new Date(Date.UTC(2026, 6, 25, 1, 30)); // Sat Jul 25 2026 01:30Z
  assert.equal(computeNextRunAt(DAILY, from).toISOString(), "2026-07-25T02:00:00.000Z");
});

test("daily: tomorrow when the hour has passed (and at exactly the hour)", () => {
  assert.equal(
    computeNextRunAt(DAILY, new Date(Date.UTC(2026, 6, 25, 2, 0))).toISOString(),
    "2026-07-26T02:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(DAILY, new Date(Date.UTC(2026, 6, 25, 23, 59))).toISOString(),
    "2026-07-26T02:00:00.000Z",
  );
});

test("daily: month/year rollover", () => {
  const from = new Date(Date.UTC(2026, 11, 31, 23, 0)); // Dec 31 2026 23:00Z
  assert.equal(computeNextRunAt(DAILY, from).toISOString(), "2027-01-01T02:00:00.000Z");
});

test("weekly: snaps forward to the next weekday, strictly after now", () => {
  // Jul 25 2026 is a Saturday; day_of_week 1 = Monday.
  const sat = new Date(Date.UTC(2026, 6, 25, 12, 0));
  assert.equal(computeNextRunAt(WEEKLY, sat).toISOString(), "2026-07-27T03:00:00.000Z");
  // Monday before the hour → today; Monday after → next week.
  assert.equal(
    computeNextRunAt(WEEKLY, new Date(Date.UTC(2026, 6, 27, 1, 0))).toISOString(),
    "2026-07-27T03:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(WEEKLY, new Date(Date.UTC(2026, 6, 27, 3, 0))).toISOString(),
    "2026-08-03T03:00:00.000Z",
  );
});

test("monthly: this month then next month, never an invalid date", () => {
  assert.equal(
    computeNextRunAt(MONTHLY, new Date(Date.UTC(2026, 6, 1, 0, 0))).toISOString(),
    "2026-07-15T04:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(MONTHLY, new Date(Date.UTC(2026, 6, 15, 4, 0))).toISOString(),
    "2026-08-15T04:00:00.000Z",
  );
  // January 31 → February still lands on the 15th (day_of_month is 1–28).
  assert.equal(
    computeNextRunAt(MONTHLY, new Date(Date.UTC(2026, 0, 31, 10, 0))).toISOString(),
    "2026-02-15T04:00:00.000Z",
  );
});

test("backup file base name: slugged, stamped, header-safe", () => {
  assert.equal(
    backupFileBaseName("Acme Holdings, Inc.", new Date(Date.UTC(2026, 6, 24, 10, 15, 0))),
    "acme-holdings-inc-backup-20260724-101500",
  );
  assert.equal(backupFileBaseName("!!!", new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "org-backup-20260102-030405");
});

test("auditBackupEvent fails closed when the audit-log write fails", async (t) => {
  t.mock.method(db, "execute", async () => {
    throw new Error("injected audit_log outage");
  });
  // A security/material operation must never be allowed to report success
  // without its evidence: the audit write failure has to reach the caller.
  await assert.rejects(
    auditBackupEvent({
      orgId: randomUUID(),
      tableName: "backup_runs",
      rowId: randomUUID(),
      actorId: null,
      changes: { event: "backup_completed" },
    }),
    /injected audit_log outage/,
  );
});

test("auditBackupEvent resolves and issues its evidence insert on success", async (t) => {
  let inserts = 0;
  t.mock.method(db, "execute", async () => {
    inserts += 1;
    return { rows: [] };
  });
  await auditBackupEvent({
    orgId: randomUUID(),
    tableName: "backup_runs",
    rowId: randomUUID(),
    actorId: null,
    changes: { event: "backup_completed", sha256: "abc" },
  });
  assert.equal(inserts, 1);
});

test("purge refuses storage deletion when its intent evidence cannot be recorded", async (t) => {
  // The append-only purge intent is the gate in front of storage destruction:
  // an audit_log outage must leave the stored bytes untouched and visible.
  t.mock.method(db, "execute", async () => {
    throw new Error("injected audit outage during purge intent");
  });
  const orgId = randomUUID();
  const runId = randomUUID();
  await assert.rejects(
    purgeBackupRun({
      orgId,
      runId,
      objectKey: backupObjectKey(orgId, runId),
      actorId: null,
      reason: "deleted",
      kind: "manual",
      fileName: "acme-backup.json.gz",
      byteSize: 1234,
      sha256: "abc",
    }),
    /injected audit outage during purge intent/,
  );
});

test("purge refuses a ledger identity that does not match its deterministic object key", async () => {
  // Storage access by an arbitrary key outside the ledger's own naming cannot
  // ride this path — it would bypass the org-scoped intent/completion chain.
  await assert.rejects(
    purgeBackupRun({
      orgId: randomUUID(),
      runId: randomUUID(),
      objectKey: `backups/${randomUUID()}/${randomUUID()}.json.gz`,
      actorId: null,
      reason: "deleted",
    }),
    /object key does not match its ledger identity/,
  );
});
