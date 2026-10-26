import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { resolveTermsDueDate } from "../ledger/document-defaults.ts";
import { loadEntities } from "./migrate.ts";
import type { EntityStream, MigrationSource, SourceEntity } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function stubSource(): MigrationSource {
  return {
    name: "terms-source",
    refKey: "termsSource",
    baseCurrency: "CAD",
    accountingPeriods: async () => [],
    entities: async () => [],
    nativeChanges: async () => {
      throw new Error("not used by this test");
    },
    trialBalance: async () => [],
    monthlyActivity: async () => [],
  } as unknown as MigrationSource;
}

function terms(sourceRef: string, fields: Record<string, unknown>): EntityStream[] {
  const record: SourceEntity = { sourceRef, naturalKey: String(fields.name), fields };
  return [{ resource: "payment_terms", records: [record] }];
}

type TermsRow = {
  id: string;
  net_days: number;
  due_day_of_month: number | null;
  discount_days: number | null;
};
type TermsAudit = {
  event: string;
  source: { ref: string };
  before: { net_days: number; due_day_of_month: number | null };
  after: { net_days: number; due_day_of_month: number | null };
};

async function storedTerms(orgId: string): Promise<TermsRow[]> {
  return withOrg(orgId, () =>
    db.execute<TermsRow>(
      sql`
    select id, net_days, due_day_of_month, discount_days from payment_terms where org_id = ${orgId} order by name`,
      "objects",
    ),
  );
}

test(
  "a re-sync corrects stored terms in place to fall due on a day of the month, audited once",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const name = "Net 30, 1st Following";
      const first = await withOrg(org.orgId, () =>
        loadEntities(
          stubSource(),
          org.orgId,
          null,
          undefined,
          undefined,
          terms("TRM-7", { name, netDays: 0, discountDays: null, discountPercent: null }),
        ),
      );
      assert.equal(first.payment_terms?.created, 1);
      const [landed] = await storedTerms(org.orgId);
      await withOrg(org.orgId, () =>
        db.execute(sql`
      insert into vendor_roles (org_id, party_id, ap_account_id, payment_terms_id, is_active)
      values (${org.orgId}, ${org.vendorId}, ${org.accounts.ap}, ${landed!.id}, true)`),
      );
      const dueOn = (documentDate: string) =>
        withOrg(org.orgId, () =>
          resolveTermsDueDate(db, org.orgId, {
            kind: "vendor_bill",
            partyId: org.vendorId,
            documentDate,
          }),
        );
      assert.equal((await dueOn("2026-10-22"))?.dueDate, "2026-10-22");

      const runId = randomUUID();
      const audit = { connectionId: null, runId, actorId: null, sourceName: "terms-source" };
      const corrected = {
        name,
        netDays: 30,
        dueDayOfMonth: 1,
        discountDays: null,
        discountPercent: null,
      };
      const second = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, audit, terms("TRM-7", corrected)),
      );
      assert.equal(second.payment_terms?.updated, 1);
      assert.equal(second.payment_terms?.failed, 0);
      assert.deepEqual(await storedTerms(org.orgId), [
        { id: landed!.id, net_days: 30, due_day_of_month: 1, discount_days: null },
      ]);
      assert.deepEqual(await dueOn("2026-10-22"), {
        termsId: landed!.id,
        termsName: name,
        netDays: 30,
        dueDayOfMonth: 1,
        dueDate: "2026-12-01",
        source: "party",
      });

      const audits = () =>
        withOrg(org.orgId, () =>
          db.execute<{ changes: TermsAudit; request_id: string | null }>(
            sql`
      select changes, request_id from audit_log
       where org_id = ${org.orgId} and table_name = 'payment_terms' and row_id = ${landed!.id}`,
            "objects",
          ),
        );
      const [entry, ...rest] = await audits();
      assert.equal(rest.length, 0);
      assert.equal(entry!.request_id, runId);
      assert.equal(entry!.changes.event, "source_payment_terms_updated");
      assert.equal(entry!.changes.source.ref, "TRM-7");
      assert.deepEqual(
        [entry!.changes.before.net_days, entry!.changes.before.due_day_of_month],
        [0, null],
      );
      assert.deepEqual(
        [entry!.changes.after.net_days, entry!.changes.after.due_day_of_month],
        [30, 1],
      );

      // Replaying unchanged terms writes no further audit.
      const third = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, audit, terms("TRM-7", corrected)),
      );
      assert.equal(third.payment_terms?.failed, 0);
      assert.equal((await audits()).length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "source terms the due-date rule cannot apply are refused by name and keep the stored row",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const name = "Net 15";
      const load = (fields: Record<string, unknown>) =>
        withOrg(org.orgId, () =>
          loadEntities(
            stubSource(),
            org.orgId,
            null,
            undefined,
            undefined,
            terms("TRM-1", { name, ...fields }),
          ),
        );
      assert.equal(
        (await load({ netDays: 15, discountDays: 5, discountPercent: "1" })).payment_terms?.failed,
        0,
      );
      const kept = await storedTerms(org.orgId);

      const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{ netDays: 0, dueDayOfMonth: 0 }, /due day of month must be a whole day from 1 to 31/],
        [{ netDays: 0, dueDayOfMonth: 32 }, /due day of month must be a whole day from 1 to 31/],
        [{ netDays: "7.5" }, /net days must be a whole number of days/],
        [{ netDays: -3 }, /net days must be a whole number of days/],
        [{ discountDays: 10 }, /state no net days/],
        [
          { netDays: 0, dueDayOfMonth: 15, discountPercent: "2", discountDayOfMonth: 5 },
          /discount that expires on a day of the month/,
        ],
      ];
      for (const [fields, message] of refusals) {
        const stats = await load(fields);
        assert.equal(stats.payment_terms?.failed, 1, JSON.stringify(fields));
        assert.match(stats.payment_terms?.errors[0]?.message ?? "", message);
      }
      assert.deepEqual(await storedTerms(org.orgId), kept);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("stored terms refuse a due day of month outside 1 to 31", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    for (const day of [0, 32]) {
      await assert.rejects(
        withOrg(org.orgId, () =>
          db.execute(sql`
        insert into payment_terms (org_id, name, net_days, due_day_of_month) values (${org.orgId}, 'Bad', 0, ${day})`),
        ),
        (error: unknown) =>
          /payment_terms_due_day_of_month_range/.test(
            String((error as { cause?: unknown }).cause ?? error),
          ),
      );
    }
    await withOrg(org.orgId, () =>
      db.execute(sql`
      insert into payment_terms (org_id, name, net_days, due_day_of_month) values (${org.orgId}, 'Month end', 0, 31)`),
    );
    assert.deepEqual(
      (await storedTerms(org.orgId)).map((row) => row.due_day_of_month),
      [31],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
