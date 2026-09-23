import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../../engine/src/platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
} from "../../../engine/src/testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const migrationSql = readFileSync(
  new URL("./0329_dunning_sent_at_delivery_evidence.sql", import.meta.url),
  "utf8",
);

type Claim = { id: string; status: string; sentAt: Date | string | null };

async function claims(orgId: string): Promise<Claim[]> {
  return (
    await db.execute<Claim>(sql`
      select id, status, sent_at as "sentAt" from dunning_log where org_id = ${orgId} order by status
    `)
  ).rows;
}

/** A pre-fix claim row: an unsent status carrying a claim-time sent_at. */
async function seedPrefixedClaim(
  orgId: string,
  status: string,
  sentAt: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into dunning_log (id, org_id, document_id, policy_id, stage_id, status, sent_at)
    values (${id}, ${orgId}, ${randomUUID()}, ${randomUUID()}, ${randomUUID()}, ${status}, ${sentAt}::timestamptz)
  `);
  return id;
}

/** Durable email evidence for a claim, as the worker leaves it. */
async function seedEmailEvidence(
  orgId: string,
  claimId: string,
  key: string,
  row: { status: string; providerMessageId: string | null; sentAt: string | null; attempts: unknown[] },
): Promise<void> {
  const deliveryKey = `obem_${createHash("sha256").update(key).digest("hex").slice(0, 40)}`;
  await db.execute(sql`
    insert into email_log (org_id, delivery_key, provider, recipients, recipient_primary,
                           subject, status, category_key, meta, provider_message_id, sent_at)
    values (${orgId}, ${deliveryKey}, 'test', '["billing@acme.test"]'::jsonb, 'billing@acme.test',
            'Reminder', ${row.status}, 'dunning',
            ${JSON.stringify({
              category: "dunning",
              dunningLogId: claimId,
              attempts: row.attempts.map((a) => ({ ...(a as object), at: new Date().toISOString() })),
            })}::jsonb,
            ${row.providerMessageId}, ${row.sentAt}::timestamptz)
  `);
}

test(
  "0329 clears claim-time sent_at only on unsent rows with no delivery evidence, with audit",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const stagedAt = "2026-06-10T12:00:00Z";
      const suppressedAt = "2026-06-11T12:00:00Z";
      const failedAt = "2026-06-12T12:00:00Z";
      const sentAt = "2026-06-13T12:00:00Z";
      const [stagedId, suppressedId, failedBareId, failedAcceptedId, stagedUncertainId, stagedDanglingId, sentId, skippedId] =
        await withBypass(async () => {
          const staged = await seedPrefixedClaim(org.orgId, "staged", stagedAt);
          const suppressed = await seedPrefixedClaim(org.orgId, "suppressed", suppressedAt);
          const failedBare = await seedPrefixedClaim(org.orgId, "failed", failedAt);
          const failedAccepted = await seedPrefixedClaim(org.orgId, "failed", failedAt);
          const stagedUncertain = await seedPrefixedClaim(org.orgId, "staged", stagedAt);
          const stagedDangling = await seedPrefixedClaim(org.orgId, "staged", stagedAt);
          const sent = await seedPrefixedClaim(org.orgId, "sent", sentAt);
          const skipped = await seedPrefixedClaim(org.orgId, "skipped", sentAt);
          // The failed claim below WAS delivered (acceptance recorded, but
          // the claim settle was lost): it is not demonstrably unsent, so
          // the migration must preserve it for the runner's reconciliation.
          await seedEmailEvidence(org.orgId, failedAccepted, `0329-accept:${failedAccepted}`, {
            status: "sent",
            providerMessageId: "provider-1",
            sentAt: "2026-06-14T12:00:00Z",
            attempts: [{ attempt: 1, outcome: "sent", detail: "provider-1" }],
          });
          // Unresolved acceptance: the letter may have gone out — preserve.
          await seedEmailEvidence(org.orgId, stagedUncertain, `0329-uncertain:${stagedUncertain}`, {
            status: "uncertain",
            providerMessageId: null,
            sentAt: null,
            attempts: [{ attempt: 1, outcome: "uncertain", detail: "acceptance state unresolved" }],
          });
          // A definitively rejected delivery is rejected-or-absent evidence:
          // the bare failed claim below carries none and must be cleared.
          await seedEmailEvidence(org.orgId, failedBare, `0329-reject:${failedBare}`, {
            status: "failed",
            providerMessageId: null,
            sentAt: null,
            attempts: [{ attempt: 1, outcome: "notSent", detail: "550 mailbox unavailable" }],
          });
          // A dangling "started" event with no outcome: the worker was lost
          // mid-flight and may have transmitted — unresolved, so preserved.
          await seedEmailEvidence(org.orgId, stagedDangling, `0329-dangling:${stagedDangling}`, {
            status: "failed",
            providerMessageId: null,
            sentAt: null,
            attempts: [{ attempt: 1, outcome: "started", detail: "sending via test" }],
          });
          return [staged, suppressed, failedBare, failedAccepted, stagedUncertain, stagedDangling, sent, skipped];
        });

      // Bootstrap posture: no ambient bypass — the file carries its own
      // SET LOCAL for the guard and RLS, inside one transaction.
      await db.execute(sql.raw(`BEGIN; ${migrationSql} COMMIT;`));

      const after = await withBypass(() => claims(org.orgId));
      const byId = new Map(after.map((c) => [c.id, c]));
      const iso = (value: Date | string | null): string | null =>
        value === null ? null : new Date(value).toISOString();
      // Demonstrably unsent with no delivery evidence: cleared.
      assert.equal(byId.get(stagedId)!.sentAt, null, "staged without evidence clears");
      assert.equal(byId.get(suppressedId)!.sentAt, null, "suppressed without evidence clears");
      assert.equal(byId.get(failedBareId)!.sentAt, null, "failed with only rejected evidence clears");
      // Everything else preserved exactly.
      assert.equal(iso(byId.get(failedAcceptedId)!.sentAt), new Date(failedAt).toISOString(), "failed with acceptance evidence preserved");
      assert.equal(iso(byId.get(stagedUncertainId)!.sentAt), new Date(stagedAt).toISOString(), "staged with uncertain evidence preserved");
      assert.equal(iso(byId.get(stagedDanglingId)!.sentAt), new Date(stagedAt).toISOString(), "staged with dangling started evidence preserved");
      assert.equal(iso(byId.get(sentId)!.sentAt), new Date(sentAt).toISOString(), "sent preserved");
      assert.equal(iso(byId.get(skippedId)!.sentAt), new Date(sentAt).toISOString(), "skipped preserved");

      // One audit row per cleared row, carrying the before image.
      const audit = (
        await withBypass(() =>
          db.execute<{ rowId: string; changes: { before: { sent_at: string }; reason: string } }>(sql`
            select row_id as "rowId", changes from audit_log
             where org_id = ${org.orgId} and table_name = 'dunning_log' and action = 'update'
               and row_id in (${stagedId}, ${suppressedId}, ${failedBareId}, ${failedAcceptedId}, ${stagedUncertainId}, ${stagedDanglingId}, ${sentId}, ${skippedId})
          `),
        )
      ).rows;
      assert.deepEqual(
        audit.map((r) => r.rowId).sort(),
        [failedBareId, stagedId, suppressedId].sort(),
        "audit names exactly the cleared rows",
      );
      for (const row of audit) {
        assert.ok(row.changes.reason.includes("0329"), "audit names the migration");
        assert.ok(typeof row.changes.before.sent_at === "string", "audit carries the before image");
      }
      const beforeById = new Map(audit.map((r) => [r.rowId, r.changes.before.sent_at]));
      assert.equal(iso(beforeById.get(stagedId)!), new Date(stagedAt).toISOString());
      assert.equal(iso(beforeById.get(suppressedId)!), new Date(suppressedAt).toISOString());
      assert.equal(iso(beforeById.get(failedBareId)!), new Date(failedAt).toISOString());

      // Re-running changes nothing and audits nothing more.
      await db.execute(sql.raw(`BEGIN; ${migrationSql} COMMIT;`));
      const rerun = await withBypass(() => claims(org.orgId));
      assert.deepEqual(
        rerun.map((c) => [c.id, iso(c.sentAt)]),
        after.map((c) => [c.id, iso(c.sentAt)]),
      );
      const auditAgain = (
        await withBypass(() =>
          db.execute<{ n: number }>(sql`
            select count(*)::int as n from audit_log
             where org_id = ${org.orgId} and table_name = 'dunning_log' and action = 'update'
               and changes ->> 'reason' like '%0329%'
          `),
        )
      ).rows[0]!.n;
      assert.equal(auditAgain, 3, "re-run audits nothing more");
    } finally {
      await withBypass(async () => {
        await db.execute(sql`delete from email_log where org_id = ${org.orgId}`);
      });
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
