import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { loadEntities } from "./migrate.ts";
import type { EntityStream, MigrationSource, SourceEntity } from "./source.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Migrated money fails closed per resource.
 *
 * Each loader persist helper runs canonicalDecimal then normalizeMoney
 * before any write; unreadable values refuse with a field-naming error
 * and land nothing. The table below drives the real loadEntities path
 * with the decimal-comma and over-scale shapes that naive coercion
 * would silently turn into money. Time entries batch their insert, so
 * one malformed line aborts the whole load instead of recording a
 * per-record error — still a refusal, never a partial write.
 */
function stubSource(): MigrationSource {
  return {
    name: "money-refusal-test",
    refKey: "moneyRefusalTest",
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

function record(sourceRef: string, fields: Record<string, unknown>): SourceEntity {
  return { sourceRef, fields };
}

function stream(resource: string, records: SourceEntity[]): EntityStream[] {
  return [{ resource, records }];
}

const COUNT_TABLES = [
  "time_types",
  "tax_codes",
  "payment_terms",
  "items",
  "projects",
  "time_entries",
] as const;

async function counts(orgId: string): Promise<Record<string, number>> {
  return withOrg(orgId, async () => {
    const out: Record<string, number> = {};
    for (const table of COUNT_TABLES) {
      const rows = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from ${sql.raw(table)} where org_id = ${orgId}`);
      out[table] = rows.rows[0]!.n;
    }
    return out;
  });
}

test(
  "reference resources refuse unreadable money and land nothing",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      // Valid wave first: every resource lands, proving the refusal wave
      // below fails on the money and not on some missing fixture.
      const valid = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined, [
          ...stream("time_types", [record("TT-1", { name: "Regular", costMultiplier: "1.5" })]),
          ...stream("tax_codes", [record("TX-1", { code: "GST", ratePercent: "5" })]),
          ...stream("payment_terms", [record("PT-1", { name: "Net 30", netDays: 30, discountPercent: "2" })]),
          ...stream("items", [record("IT-1", { name: "Labour", kind: "service", defaultCost: "50", defaultRate: "100" })]),
          ...stream("projects", [record("PR-1", { name: "Job", contractValue: "10000" })]),
        ]),
      );
      for (const resource of ["time_types", "tax_codes", "payment_terms", "items", "projects"]) {
        assert.equal(valid[resource]?.failed ?? -1, 0, `${resource} valid wave lands`);
      }
      const landed = await counts(org.orgId);

      const bad = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined, [
          ...stream("time_types", [record("TT-2", { name: "Bad", costMultiplier: "12,34" })]),
          ...stream("tax_codes", [record("TX-2", { code: "BAD", ratePercent: "1.23456" })]),
          ...stream("payment_terms", [record("PT-2", { name: "Bad", discountPercent: "12,34" })]),
          ...stream("items", [record("IT-2", { name: "Bad", defaultCost: "12,34", defaultRate: "1.23456" })]),
          ...stream("projects", [record("PR-2", { name: "Bad", contractValue: "12,34" })]),
        ]),
      );
      const complaints: Array<[string, RegExp]> = [
        ["time_types", /cost multiplier must be an exact decimal/],
        ["tax_codes", /tax-code rate must be an exact decimal/],
        ["payment_terms", /payment-term discount must be an exact decimal/],
        ["items", /item default (cost|rate) must be an exact decimal/],
        ["projects", /project contract value must be an exact decimal/],
      ];
      for (const [resource, message] of complaints) {
        assert.equal(bad[resource]?.failed, 1, `${resource} refuses`);
        assert.match(bad[resource]?.errors[0]?.message ?? "", message, `${resource} names the field`);
      }
      // Nothing new landed anywhere.
      assert.deepEqual(await counts(org.orgId), landed);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "payment-term replays refuse unreadable money on the update branch",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const first = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined,
          stream("payment_terms", [record("PT-9", { name: "Net 30", netDays: 30, discountPercent: "2" })])),
      );
      assert.equal(first.payment_terms?.failed ?? -1, 0);
      const second = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined,
          stream("payment_terms", [record("PT-9", { name: "Net 30", netDays: 30, discountPercent: "1.23456" })])),
      );
      assert.equal(second.payment_terms?.failed, 1);
      assert.match(second.payment_terms?.errors[0]?.message ?? "", /payment-term discount must be an exact decimal/);
      const kept = await withOrg(org.orgId, () =>
        db.execute<{ discount: string }>(sql`
          select discount_percent::text as discount from payment_terms where org_id = ${org.orgId}`),
      );
      assert.deepEqual(kept.rows.map((row) => row.discount), ["2.0000"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "time entries abort the load on unreadable money with nothing written",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      const seeded = await withOrg(org.orgId, () =>
        loadEntities(stubSource(), org.orgId, null, undefined, undefined,
          stream("parties", [record("EMP-1", { displayName: "Crew", kind: "company", isActive: true })])),
      );
      assert.equal(seeded.parties?.failed ?? -1, 0);
      const cases: Array<{ field: string; message: RegExp }> = [
        { field: "hours", message: /time-entry hours must be an exact decimal/ },
        { field: "costRate", message: /time-entry cost rate must be an exact decimal/ },
        { field: "billRate", message: /time-entry bill rate must be an exact decimal/ },
      ];
      for (const [index, { field, message }] of cases.entries()) {
        await assert.rejects(
          withOrg(org.orgId, () =>
            loadEntities(stubSource(), org.orgId, null, undefined, undefined,
              stream("time_entries", [record(`TE-${index}`, {
                employeeRef: "EMP-1", workedOn: "2026-07-15",
                hours: field === "hours" ? "12,34" : "8",
                costRate: field === "costRate" ? "1.23456" : "50",
                billRate: field === "billRate" ? "12,34" : "100",
              })]))),
          (error: unknown) => error instanceof Error && message.test(error.message),
          `time entry ${field}`,
        );
      }
      assert.equal((await counts(org.orgId)).time_entries, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
