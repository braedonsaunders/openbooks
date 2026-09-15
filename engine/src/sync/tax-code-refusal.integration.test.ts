/**
 * A source tax line that carries money but no resolvable tax code must be
 * refused at the mirror boundary — with a named error that names the source
 * transaction — and must never reach the posting kernel's evidence guard.
 *
 * Today the mirror stores the line (tax_code_id NULL, nonzero tax_amount) and
 * lets `postDocument` throw the generic kernel `PostingError: line N has a tax
 * amount but no calculation evidence`, which names only a line number. Worse,
 * a non-posting order takes the same path with no kernel post at all, so the
 * phantom tax persists silently: ordersNew 1, no failure, tax money with no
 * code and no calculation evidence sitting in the ledger's shadow.
 *
 * These cases pin the upstream contract: both the posting invoice and the
 * non-posting order fail the run with a source-attributed refusal.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { createScratchOrg, type ScratchOrg } from "../test-fixtures.ts";
import { runSync } from "./sync.ts";
import type {
  MigrationSource,
  NativeChanges,
  SourceEntity,
} from "./source.ts";
import type { NativeDocument } from "./native.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Lease a fresh scratch org per top-level test. The suite's fixture lifecycle
 * hook drains forgotten leases at every top-level test boundary, so an org
 * memoized across tests is reset — and re-leased to another worker process —
 * as soon as the first test ends.
 */
async function ctx(): Promise<ScratchOrg> {
  return createScratchOrg();
}

async function newConnection(orgId: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into connections (id, org_id, source, display_name)
    values (${id}, ${orgId}, 'qbo', ${`codeless-tax-test-${id.slice(0, 8)}`})`);
  return id;
}

/** Adapter whose tax money resolves to no openbooks tax code. */
class CodelessTaxSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency = "CAD";

  orderMode = false;

  constructor(private readonly o: ScratchOrg) {}

  accountingPeriods(): Promise<SourceEntity[]> {
    return Promise.resolve([]);
  }

  private document(): NativeDocument {
    return {
      sourceRef: "TST-TAX",
      kind: this.orderMode ? "sales_order" : "customer_invoice",
      posting: !this.orderMode,
      lifecycleStatus: "approved",
      partyId: this.o.customerId,
      currency: "CAD",
      fxRate: "1",
      documentDate: this.o.date,
      postingDate: this.o.date,
      postingPeriodId: this.o.periodId,
      dueDate: this.o.date,
      memo: null,
      referenceNumber: null,
      controlAccountId: null,
      subtotal: "100",
      total: "113",
      lines: [{
        accountId: this.o.accounts.revenue,
        itemId: null,
        quantity: "1",
        unitPrice: "100",
        amount: "100",
        taxAmount: "13",
        taxOverridden: true,
        taxCodeId: null,
        departmentId: null,
        projectId: null,
        description: "codeless-tax probe",
        lineNumber: 1,
      }],
    };
  }

  nativeChanges(): Promise<NativeChanges> {
    return Promise.resolve({
      documents: [this.document()],
      applications: [],
      deletedRefs: [],
      syncedThrough: new Date("2026-07-16T00:00:00.000Z"),
      unbuildable: [],
    });
  }

  trialBalance(): Promise<never[]> {
    return Promise.resolve([]);
  }

  monthlyActivity(): Promise<never[]> {
    return Promise.resolve([]);
  }

  openItems(): Promise<{ ref: string; unpaid: string }[]> {
    return Promise.resolve([]);
  }
}

test(
  "a posting invoice with tax money but no tax code is refused upstream",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);
    const source = new CodelessTaxSource(o);

    await assert.rejects(
      () =>
        runSync(source, "codeless-tax-test", {
          kind: "full_migration",
          orgId: o.orgId,
          connectionId,
          since: null,
          loadEntitiesFirst: false,
        }),
      /TST-TAX.*no resolved tax code/,
      "the refusal must name the source transaction and fire before the kernel guard",
    );
  },
);

test(
  "a non-posting order with tax money but no tax code is refused, not stored",
  { skip: !DB, timeout: 180_000 },
  async () => {
    const o = await ctx();
    const connectionId = await newConnection(o.orgId);
    const source = new CodelessTaxSource(o);
    source.orderMode = true;

    await assert.rejects(
      () =>
        runSync(source, "codeless-tax-test", {
          kind: "full_migration",
          orgId: o.orgId,
          connectionId,
          since: null,
          loadEntitiesFirst: false,
        }),
      /TST-TAX.*no resolved tax code/,
      "phantom tax on an order must fail the run instead of persisting silently",
    );

    const rows = (await db.execute(sql`
      select id from documents
       where org_id = ${o.orgId} and custom->>'qboId' = 'TST-TAX'`)).rows;
    assert.equal(
      rows.length,
      0,
      "the refused order leaves no stored document behind",
    );
  },
);
