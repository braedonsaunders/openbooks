import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { syncNetSuiteFixedAssets } from "./netsuite-fixed-assets.ts";
import type { NetSuiteSource, NetSuiteFixedAssetSnapshot } from "./netsuite-source.ts";
import type { NativeDocument } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

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

function stubSource(documents: NativeDocument[]): NetSuiteSource {
  return {
    name: "netsuite",
    refKey: "nsFamMoneyTest",
    baseCurrency: "CAD",
    fixedAssets: async () => EMPTY_SNAPSHOT,
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
          syncNetSuiteFixedAssets(stubSource(documents), { orgId: org.orgId, connectionId: randomUUID() }),
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
