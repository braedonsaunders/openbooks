import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { withSimClock } from "../platform/clock.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postEntry } from "../journal/post-entry.ts";
import { reverseProjectGlEntry } from "../journal/origin-entry.ts";
import { syncNetSuiteFixedAssets } from "./netsuite-fixed-assets.ts";
import type { NetSuiteSource, NetSuiteFixedAssetSnapshot } from "./netsuite-source.ts";
import type { NativeDocument } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

async function createConnection(orgId: string): Promise<string> {
  const id = randomUUID();
  const saved = (await db.execute<{ id: string }>(sql`insert into connections(id,org_id,source,display_name) values(${id},${orgId},'netsuite','Fixed assets source') returning id`)).rows[0];
  if (!saved) throw new Error('The fixed assets connection fixture was not saved');
  return saved.id;
}


const EMPTY_SNAPSHOT: NetSuiteFixedAssetSnapshot = {
  extractedAt: "2026-07-16T00:00:00.000Z",
  sourceAccount: "stub",
  bridgeVersion: "stub",
  assets: [],
  assetTypes: [],
  depreciationHistory: [],
  assetValues: [],
  depreciationMethods: [],
  alternateMethods: [],
  alternateDepreciation: [],
  alternateDefinitions: [],
  assetLifetimes: [],
};

function line(overrides: Record<string, unknown> = {}): NativeDocument["lines"][number] {
  return {
    accountId: randomUUID(),
    itemId: null,
    quantity: "1",
    unitPrice: "100",
    amount: "100",
    taxAmount: "0",
    taxOverridden: false,
    taxCodeId: null,
    departmentId: null,
    projectId: null,
    description: "stub line",
    lineNumber: 1,
    ...overrides,
  };
}

function doc(
  org: { subsidiaryId: string; date: string; periodId: string },
  overrides: Partial<NativeDocument> & { sourceRef: string },
): NativeDocument {
  return {
    kind: "vendor_bill",
    posting: true,
    lifecycleStatus: "approved",
    partyId: null,
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    fxRate: "1",
    documentDate: org.date,
    postingDate: org.date,
    postingPeriodId: org.periodId,
    dueDate: org.date,
    memo: null,
    referenceNumber: null,
    controlAccountId: null,
    subtotal: "100",
    total: "100",
    lines: [line()],
    ...overrides,
  } as NativeDocument;
}

function stubSource(documents: NativeDocument[], snapshot: NetSuiteFixedAssetSnapshot = EMPTY_SNAPSHOT): NetSuiteSource {
  return {
    name: "netsuite",
    refKey: "nsFamMoneyTest",
    baseCurrency: "CAD",
    fixedAssets: async () => snapshot,
    fixedAssetTransactionIds: async () => [],
    fixedAssetAccountBalances: async () => [],
    nativeTransactionsByIds: async () => ({
      documents,
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-16T00:00:00.000Z"),
      unbuildable: [],
    }),
  } as unknown as NetSuiteSource;
}

test(
  "an invalid FAM extraction timestamp falls back to the organization's business day",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs
           set settings = settings || ${JSON.stringify({
             timeZone: "Pacific/Auckland",
             features: { fixedAssets: true },
           })}::jsonb
         where id = ${org.orgId}`);

      await withSimClock("2028-09-30T11:30:00Z", async () => {
        await assert.rejects(
          syncNetSuiteFixedAssets(
            stubSource([], { ...EMPTY_SNAPSHOT, extractedAt: "invalid timestamp" }),
            { orgId: org.orgId, connectionId: await createConnection(org.orgId) },
          ),
          /no accounting period for the FAM snapshot 2028-10-01/,
        );
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("the FAM ledger tie keeps a reversed original beside its mirror", { skip: !DB, timeout: 180_000 }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Migration operator", "admin");
    await db.execute(sql`update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', coalesce(settings -> 'features', '{}'::jsonb) || '{"fixedAssets": true}'::jsonb) where id = ${org.orgId}`);
    for (const [ref, id] of [["FA-COST", org.accounts.invAsset], ["FA-ACCUM", org.accounts.adjustment], ["FA-EXP", org.accounts.cogs]]) await db.execute(sql`update accounts set custom = custom || jsonb_build_object('nsId', ${ref}::text, 'nsFamMoneyTest', ${ref}::text) where id = ${id} and org_id = ${org.orgId}`);
    const { entryId } = await postEntry(db, { orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId, entryNumber: "FA-DELETED", postingDate: org.date, periodId: org.periodId, origin: "migration", currency: "CAD", lines: [{ accountId: org.accounts.invAsset, amount: "100" }, { accountId: org.accounts.clearing, amount: "-100" }] });
    await reverseProjectGlEntry(org.orgId, actor, entryId, "Source transaction deleted", "2026-07-20");
    await db.execute(sql`update subsidiaries set custom = coalesce(custom, '{}'::jsonb) || '{"nsId":"SUB"}'::jsonb where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const accounts = { custrecord_assettypeassetacc: "FA-COST", custrecord_assettypedepracc: "FA-ACCUM", custrecord_assettypedeprchargeacc: "FA-EXP" };
    const assets = [{ id: "A1", custrecord_assettype: "7", custrecord_assetsubsidiary: "SUB", custrecord_assetcost: "0", custrecord_assetmainacc: "FA-COST", custrecord_assetdepracc: "FA-ACCUM", custrecord_assetdeprchargeacc: "FA-EXP" }];
    const result = await syncNetSuiteFixedAssets(Object.assign(stubSource([], { ...EMPTY_SNAPSHOT, assetTypes: [{ id: "7", name: "Equipment", ...accounts }], assets }), { fixedAssetAccountBalances: async () => new Map() }), { orgId: org.orgId, connectionId: await createConnection(org.orgId) });
    assert.equal(result.fixedAssetLedger.balances.find((b) => b.accountRef === "FA-COST")?.target, "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * FAM-sourced money fails closed at the document boundary.
 *
 * Every amount a NetSuite FAM transaction carries runs through the
 * persist helpers before any row is written. Each case below feeds one
 * unreadable value through the real syncNetSuiteFixedAssets path and
 * asserts the field-naming refusal with no document stored.
 */
test(
  "FAM documents refuse unreadable money with nothing stored",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
                 coalesce(settings -> 'features', '{}'::jsonb) || '{"fixedAssets": true}'::jsonb)
         where id = ${org.orgId}`);
      const cases: Array<{ label: string; documents: NativeDocument[]; message: RegExp }> = [
        {
          label: "fxRate",
          documents: [doc(org, { sourceRef: "FAM-FX", fxRate: "12,34" })],
          message: /FX rate must be an exact decimal/,
        },
        {
          label: "subtotal",
          documents: [doc(org, { sourceRef: "FAM-SUB", subtotal: "1.23456" })],
          message: /subtotal must be an exact decimal/,
        },
        {
          label: "total",
          documents: [doc(org, { sourceRef: "FAM-TOT", total: "abc" })],
          message: /total must be an exact decimal/,
        },
        {
          label: "amount",
          documents: [doc(org, { sourceRef: "FAM-AMT", lines: [line({ amount: "1,234" })] })],
          message: /amount must be an exact decimal/,
        },
        {
          label: "taxAmount",
          documents: [doc(org, { sourceRef: "FAM-TAX", lines: [line({ taxAmount: "$5" })] })],
          message: /taxAmount must be an exact decimal/,
        },
      ];
      for (const { label, documents, message } of cases) {
        await assert.rejects(
          syncNetSuiteFixedAssets(stubSource(documents), { orgId: org.orgId, connectionId: await createConnection(org.orgId) }),
          (error: unknown) => error instanceof Error && message.test(error.message),
          `FAM ${label}`,
        );
      }
      const stored = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from documents
         where org_id = ${org.orgId} and custom ? 'nsFamMoneyTest'`);
      assert.equal(stored.rows[0]!.n, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
