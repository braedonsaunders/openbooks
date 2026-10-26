import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { stubModules } from "../testing/stub-modules.ts";

// Key-echo translator with real copy for the void markers, so the test pins
// the rendered words (not just the plumbing) without a locale catalog.
const INTL_WITH_VOID_COPY =
  `export async function getTranslations(){` +
  `const t=(key,vars)=>{let s=String(key);` +
  `if(key==='status.voided')s='Voided';` +
  `if(key==='drillDrawer.reversalOf')s='Reversal of {entry}';` +
  `for(const [k,v] of Object.entries(vars??{}))s=s.split('{'+k+'}').join(String(v));` +
  `return s};t.has=()=>false;return t}` +
  `export async function getMessages(){return {}}` +
  `export async function getLocale(){return 'en'}` +
  `export function useTranslations(){return (key)=>String(key)}`;

stubModules({ intl: INTL_WITH_VOID_COPY, navigation: false, authz: false, features: false });

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "./money-server" || specifier.endsWith("/money-server")) {
      return {
        shortCircuit: true,
        url: `data:text/javascript,export async function getMoneyFormatter() { return { money: (value) => String(value) } }`,
      };
    }
    return next(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, env, withBypass, withBypassContext, withOrgContext } =
  await import("@openbooks/engine/platform/db");
const { createScratchOrg, createScratchUser, dropScratchOrg } =
  await import("@openbooks/engine/testing/fixtures");
const { markEntryReversed, postEntry } =
  await import("@openbooks/engine/testing/journal/post-entry");
const { reversalJournalLines } =
  await import("@openbooks/engine/testing/records/reversal-journal-lines");
const { loadReportDrillData } = await import("./report-drill-data");
const { transactionDetail } = await import("./reports/transaction-detail");
const { profitAndLossView } = await import("./statement-matrix");
const { encodeReportDrillTarget, parseReportDrillTarget } = await import("./report-drill");
const { decimalAdd } = await import("./statement-format");
import type { ReportDrillTarget } from "./report-drill";

/**
 * A statement drill must foot exactly to its cell. The old ledger drill
 * split every line into debit/credit magnitudes with no void marker, so a
 * month holding a voided journal and its reversal summed magnitudes against
 * a netted cell and never tied. Lines now carry their statement-signed
 * amount (reversal legs print negative), voided originals read "Voided",
 * reversals read "Reversal of …", and complete pairs can hide (they net to
 * zero, so the net never moves). A pair split across the window edge is
 * never half-hidden.
 */
type Scratch = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedExpense(
  org: Scratch,
  actorId: string,
  tag: string,
  total: string,
): Promise<string> {
  const entryId = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into journal_entries(
      id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
      status, origin, created_by, updated_by
    ) values (
      ${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${tag},
      ${org.date}, ${org.periodId}, 'draft', 'manual', ${actorId}, ${actorId}
    )
  `),
  );
  await withBypassContext(() =>
    db.execute(sql`
    insert into journal_lines(
      id, org_id, entry_id, line_number, account_id, subsidiary_id,
      is_open_item, amount, currency, txn_amount, fx_rate
    ) values
      (${randomUUID()}, ${org.orgId}, ${entryId}, 1, ${rentId(org)}, ${org.subsidiaryId},
       false, ${total}, 'CAD', ${total}, '1'),
      (${randomUUID()}, ${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId},
       false, ${`-${total}`}, 'CAD', ${`-${total}`}, '1')
  `),
  );
  await withBypassContext(() =>
    db.execute(
      sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`,
    ),
  );
  return entryId;
}

const rentAccounts = new Map<string, string>();
function rentId(org: Scratch): string {
  const id = rentAccounts.get(org.orgId);
  assert.ok(id, "rent account seeded");
  return id;
}

async function seedRentAccount(org: Scratch): Promise<void> {
  const id = randomUUID();
  await withBypassContext(() =>
    db.execute(sql`
    insert into accounts (id, org_id, number, name, type)
    values (${id}, ${org.orgId}, '6100', 'Rent', 'expense')
  `),
  );
  rentAccounts.set(org.orgId, id);
}

/** Native void shape: the original is marked reversed and a negated mirror
 *  posts under a -VOID number linked through reverses_entry_id. */
async function voidJournal(
  org: Scratch,
  actorId: string,
  entryId: string,
  tag: string,
  date: string,
  periodId: string,
): Promise<string> {
  return withBypass(async () => {
    const rows = (await db.execute(
      sql`select * from journal_lines where entry_id = ${entryId} and org_id = ${org.orgId}`,
      "objects",
    )) as Record<string, unknown>[];
    const mirror = reversalJournalLines(
      rows.map((line) => ({
        lineNumber: line.line_number as number,
        accountId: line.account_id as string,
        subsidiaryId: line.subsidiary_id as string,
        amount: String(line.amount),
        currency: line.currency as string,
        txnAmount: String(line.txn_amount),
        fxRate: String(line.fx_rate),
        memo: line.memo as string | null,
        partyId: line.party_id as string | null,
        departmentId: line.department_id as string | null,
        projectId: line.project_id as string | null,
        locationId: line.location_id as string | null,
        classId: line.class_id as string | null,
        equipmentUnitId: line.equipment_unit_id as string | null,
        extraDims: (line.extra_dims ?? {}) as Record<string, unknown>,
        paymentCardId: line.payment_card_id as string | null,
        taxCodeId: line.tax_code_id as string | null,
        quantity: line.quantity as string | null,
        unit: line.unit as string | null,
        custom: (line.custom ?? {}) as Record<string, unknown>,
        contributorKind: (line.contributor_kind ?? null) as string | null,
        contributorRef: (line.contributor_ref ?? null) as string | null,
      })),
      { entryId: "", orgId: org.orgId },
    );
    const posted = await postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `${tag}-VOID`,
      postingDate: date,
      periodId,
      memo: `Reversal: void ${tag}`,
      origin: "manual",
      reversesEntryId: entryId,
      actorId,
      lines: mirror.map((line) => ({
        accountId: line.accountId,
        subsidiaryId: line.subsidiaryId,
        amount: line.amount,
        currency: line.currency,
        txnAmount: line.txnAmount,
        fxRate: line.fxRate,
        memo: line.memo,
        partyId: line.partyId,
        departmentId: line.departmentId,
        projectId: line.projectId,
        locationId: line.locationId,
        classId: line.classId,
        equipmentUnitId: line.equipmentUnitId,
        extraDims: (line.extraDims ?? {}) as Record<string, unknown>,
        paymentCardId: line.paymentCardId,
        taxCodeId: line.taxCodeId,
        quantity: line.quantity,
        unit: line.unit,
        custom: (line.custom ?? {}) as Record<string, unknown>,
        contributorKind: line.contributorKind,
        contributorRef: line.contributorRef,
        lineNumber: line.lineNumber,
      })),
    });
    await markEntryReversed(db, { orgId: org.orgId, entryId, actorId });
    return posted.entryId;
  });
}

const PNL_LABELS = {
  revenue: "Revenue",
  costOfGoodsSold: "Cost of goods sold",
  grossProfit: "Gross profit",
  expenses: "Expenses",
  netIncome: "Net income",
  totalOf: (section: string) => `Total ${section}`,
};

function expenseTarget(org: Scratch, extra?: { hideVoidPairs?: boolean }): ReportDrillTarget {
  return {
    kind: "ledger",
    label: "Total Expenses",
    accountTypes: ["expense"],
    from: "2026-07-01",
    to: "2026-07-31",
    mode: "flow",
    bookId: org.bookId,
    ...extra,
  };
}

function drillAuthz(org: Scratch, actorId: string) {
  return {
    user: {
      id: actorId,
      email: "reporter@example.com",
      name: "Reporter",
      roles: [],
      orgId: org.orgId,
      envKind: "production",
      productionOrgId: org.orgId,
      homeUserId: actorId,
      homeOrgId: org.orgId,
      isSuperAdmin: true,
    },
    permissions: new Set<string>(["*"]),
    allowedSubsidiaryIds: null,
  } as const;
}

test(
  "a voided journal drill foots exactly to the P&L cell with void markers",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const scratch = await withBypass(() => createScratchOrg());
    const actorId = await withBypass(() => createScratchUser(scratch.orgId, "Reporter", "admin"));
    try {
      await seedRentAccount(scratch);
      await seedExpense(scratch, actorId, "VOID-OK", "1000.0000");
      const originalId = await seedExpense(scratch, actorId, "VOID-JE1", "3555.0000");
      const reversalId = await voidJournal(
        scratch,
        actorId,
        originalId,
        "VOID-JE1",
        scratch.date,
        scratch.periodId,
      );

      // The statement cell nets the pair to zero: only the clean journal reads.
      const view = await withOrgContext(scratch.orgId, () =>
        withBypassContext(() =>
          profitAndLossView({ from: "2026-07-01", to: "2026-07-31" }, "July 2026", PNL_LABELS, {
            orgId: scratch.orgId,
          }),
        ),
      );
      const cell = view.lines.find(
        (line) => line.kind === "subtotal" && line.label === "Total Expenses",
      );
      const cellValues = cell?.values;
      assert.ok(cellValues?.[0] !== undefined, "the P&L carries a Total Expenses cell");
      assert.equal(String(cellValues[0]), "1000.0000");

      const detail = await withBypassContext(() =>
        transactionDetail({
          accountTypes: ["expense"],
          from: "2026-07-01",
          to: "2026-07-31",
          mode: "flow",
          orgId: scratch.orgId,
          bookId: scratch.bookId,
          canSeePayroll: true,
        }),
      );
      assert.equal(detail.net, "1000.0000");
      let signed = "0";
      for (const line of detail.lines) signed = decimalAdd(signed, line.signed);
      assert.equal(signed, detail.net, "statement-signed lines sum exactly to the cell");
      assert.equal(detail.voidPairLines, 2, "both legs of the in-window pair count");

      const byEntry = new Map(detail.lines.map((line) => [line.entryId, line]));
      const original = byEntry.get(originalId);
      const reversal = byEntry.get(reversalId);
      assert.equal(original?.entryStatus, "reversed");
      assert.equal(original?.signed, "3555.0000");
      assert.equal(reversal?.reversesEntryId, originalId);
      assert.equal(reversal?.reversesEntryNumber, "VOID-JE1");
      assert.equal(reversal?.signed, "-3555.0000");

      // The drawer renders the same footing: one signed Amount column plus a
      // status marker, reached through the real URL codec like a clicked cell.
      const parsed = parseReportDrillTarget(encodeReportDrillTarget(expenseTarget(scratch)));
      assert.ok(parsed, "the drill target survives its URL codec");
      const drill = await withBypass(() =>
        loadReportDrillData(
          parsed,
          { ...drillAuthz(scratch, actorId), allowedSubsidiaryIds: null },
          1,
          "en",
        ),
      );
      assert.deepEqual(
        drill.columns.map((column) => column.align),
        [undefined, undefined, undefined, undefined, "right", undefined],
      );
      const amountIdx = 4;
      const statusIdx = 5;
      let displayed = "0";
      for (const row of drill.rows) displayed = decimalAdd(displayed, String(row.cells[amountIdx]));
      assert.equal(displayed, "1000.0000", "displayed amounts sum exactly to the net total");
      const statuses = new Map(
        drill.rows.map((row) => [String(row.cells[1]), String(row.cells[statusIdx])]),
      );
      assert.equal(statuses.get("VOID-JE1"), "Voided");
      assert.equal(statuses.get("VOID-JE1-VOID"), "Reversal of VOID-JE1");
      assert.equal(drill.voidPairLines, 2);
    } finally {
      await withBypass(() => dropScratchOrg(scratch.orgId));
    }
  },
);

test(
  "hiding void pairs drops the pair and keeps the net",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const scratch = await withBypass(() => createScratchOrg());
    const actorId = await withBypass(() => createScratchUser(scratch.orgId, "Reporter", "admin"));
    try {
      await seedRentAccount(scratch);
      await seedExpense(scratch, actorId, "VOID-OK", "1000.0000");
      const originalId = await seedExpense(scratch, actorId, "VOID-JE1", "3555.0000");
      await voidJournal(scratch, actorId, originalId, "VOID-JE1", scratch.date, scratch.periodId);

      const parsed = parseReportDrillTarget(
        encodeReportDrillTarget(expenseTarget(scratch, { hideVoidPairs: true })),
      );
      assert.ok(
        parsed && parsed.kind === "ledger" && parsed.hideVoidPairs === true,
        "the hide flag survives its URL codec",
      );
      const drill = await withBypass(() =>
        loadReportDrillData(
          parsed,
          { ...drillAuthz(scratch, actorId), allowedSubsidiaryIds: null },
          1,
          "en",
        ),
      );
      assert.equal(drill.total, 1, "only the clean journal remains");
      assert.deepEqual(
        drill.rows.map((row) => String(row.cells[1])),
        ["VOID-OK"],
      );
      let displayed = "0";
      for (const row of drill.rows) displayed = decimalAdd(displayed, String(row.cells[4]));
      assert.equal(displayed, "1000.0000", "the net is unchanged by hiding a zero-net pair");
      assert.equal(drill.voidPairLines, 0);
      assert.ok(
        drill.rows.every((row) => String(row.cells[5]) === ""),
        "no void markers remain",
      );
    } finally {
      await withBypass(() => dropScratchOrg(scratch.orgId));
    }
  },
);

test(
  "a pair split across the window edge is never half-hidden",
  { skip: !env.OPENBOOKS_DB_URL },
  async () => {
    const scratch = await withBypass(() => createScratchOrg());
    const actorId = await withBypass(() => createScratchUser(scratch.orgId, "Reporter", "admin"));
    try {
      await seedRentAccount(scratch);
      const originalId = await seedExpense(scratch, actorId, "VOID-JE2", "500.0000");
      const calendar = (
        await withBypassContext(() =>
          db.execute<{ fiscal_calendar_id: string }>(
            sql`
      select fiscal_calendar_id from accounting_periods where id = ${scratch.periodId}`,
            "objects",
          ),
        )
      )[0];
      assert.ok(calendar, "the scratch period carries a fiscal calendar");
      const augustPeriodId = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values
        (${augustPeriodId}, ${scratch.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${calendar.fiscal_calendar_id})`),
      );
      await voidJournal(scratch, actorId, originalId, "VOID-JE2", "2026-08-05", augustPeriodId);

      // July keeps the original (its reversal posts in August): hiding must
      // not drop a leg whose partner sits outside the window.
      const detail = await withBypassContext(() =>
        transactionDetail({
          accountTypes: ["expense"],
          from: "2026-07-01",
          to: "2026-07-31",
          mode: "flow",
          orgId: scratch.orgId,
          bookId: scratch.bookId,
          canSeePayroll: true,
          hideVoidPairs: true,
        }),
      );
      assert.equal(detail.net, "500.0000");
      assert.equal(detail.voidPairLines, 0, "no complete pair sits inside the July window");
      assert.deepEqual(
        detail.lines.map((line) => line.entryId),
        [originalId],
      );
      assert.equal(detail.lines[0]?.entryStatus, "reversed", "the original still reads voided");
    } finally {
      await withBypass(() => dropScratchOrg(scratch.orgId));
    }
  },
);
