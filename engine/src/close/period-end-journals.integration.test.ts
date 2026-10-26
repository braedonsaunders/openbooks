import { decideReopenFixture, requestReviewedReopenFixture } from "../testing/close.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  assertPeriodModulesOpen,
  CloseError,
  PeriodClosedError,
} from "../periods/period-policy.ts";
import { PNL_TYPES } from "../records/account-types.ts";
import {} from "./reopening.ts";
import {
  generatePeriodEndJournals,
  PeriodEndJournalError,
  periodEndJournalCloseCheck,
  periodEndJournalHistory,
  periodEndPolicyWriteRefusal,
  previewPeriodEndJournals,
  reversePeriodEndJournals,
} from "./period-end-journals.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  balancesThrough,
  closeScratchPeriods,
  postScratchEntry,
  postScratchYearActivity,
  recordPeriodEndPolicy,
  seedPeriodEndYear,
  type PeriodEndYear,
} from "../testing/period-end-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const REASON = "Statutory closing of fiscal year 2026";

/** Every FY2026 period except December, the closing period, hard-closed. */
function closedYearPeriods(year: PeriodEndYear): string[] {
  return Array.from({ length: 11 }, (_, index) =>
    year.periods.get(`2026-${String(index + 1).padStart(2, "0")}`)!,
  );
}

async function readyYear(
  org: ScratchOrg,
  options: { incomeSummary?: boolean; balanceSheetJournals?: boolean } = {},
) {
  const actors = await seedFlowActors(org.orgId);
  await grantScratchPermissions(org.orgId, actors.adminId, ["close.run"]);
  const year = await seedPeriodEndYear(org);
  await postScratchYearActivity(org, year, actors.adminId);
  await closeScratchPeriods(org, actors.adminId, closedYearPeriods(year));
  await recordPeriodEndPolicy(org, year, { actorId: actors.adminId, ...options });
  return { actors, year, december: year.periods.get("2026-12")! };
}

async function incomeStatementTotal(org: ScratchOrg, endsOn: string): Promise<string> {
  const rows = await db.execute<{ total: string }>(
    sql`
    select coalesce(sum(l.amount), 0)::text as total
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounting_periods p on p.id = e.period_id and p.org_id = e.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${org.orgId} and e.book_id = ${org.bookId} and e.status in ('posted', 'reversed')
       and p.ends_on <= ${endsOn}::date and a.type = any(${`{${PNL_TYPES.join(",")}}`}::text[])`,
    "objects",
  );
  return rows[0]!.total;
}

test(
  "generation closes every income-statement balance into retained earnings once, and reruns post nothing",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org);
      const preview = await previewPeriodEndJournals(org.orgId, { periodId: december });
      assert.deepEqual(preview.problems, []);
      const entity = preview.entities.find(
        (candidate) => candidate.subsidiaryId === org.subsidiaryId,
      )!;
      assert.equal(entity.status, "not_generated");
      // Periods are named by their fiscal position, never the stored "2026-12",
      // and carry the dates presenters label them with.
      assert.equal(preview.fiscalYear.closingPeriod?.name, "P12 FY2026");
      assert.deepEqual(preview.fiscalYear.closingPeriod?.periodRef, {
        fiscalYear: 2026,
        periodNumber: 12,
        adjustment: false,
        startsOn: "2026-12-01",
        endsOn: "2026-12-31",
      });
      assert.ok(entity.journals.length > 0);
      assert.ok(entity.journals.every((journal) => journal.periodName === "P12 FY2026"));
      // Revenue 1000.25 less rent 400.10 and cost of sales 100.05.
      assert.equal(entity.fiscalYearEarnings, "500.1000");
      // December 2025 revenue was never closed by journal: it is swept and shown apart.
      assert.equal(entity.priorUnclosedEarnings, "50.0000");

      const result = await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      assert.equal(result.generated.length, 1);
      assert.deepEqual(result.refused, []);
      const [generated] = result.generated;

      const entries = await db.execute<{
        origin: string;
        period_id: string;
        posting_date: string;
        status: string;
      }>(
        sql`
      select origin, period_id, posting_date::text as posting_date, status from journal_entries
       where org_id = ${org.orgId} and id = any(${`{${generated!.entryIds.join(",")}}`}::uuid[])`,
        "objects",
      );
      assert.deepEqual(
        entries.map((entry) => [entry.origin, entry.period_id, entry.posting_date, entry.status]),
        [["closing", december, "2026-12-31", "posted"]],
      );

      assert.equal(
        await incomeStatementTotal(org, "2026-12-31"),
        "0.0000",
        "every income-statement account is zero through the year end",
      );
      const balances = await balancesThrough(org, "2026-12-31");
      assert.equal(
        balances.get(year.retainedEarningsId),
        "-550.1000",
        "retained earnings carries the closed earnings",
      );

      const set = (
        await db.execute<{
          status: string;
          generation: number;
          content_hash: string;
          fiscal_year_earnings: string;
          reason: string;
          generated_by: string;
        }>(
          sql`
      select status, generation, content_hash, fiscal_year_earnings::text as fiscal_year_earnings, reason, generated_by
        from period_end_journal_sets where org_id = ${org.orgId} and id = ${generated!.setId}`,
          "objects",
        )
      )[0]!;
      assert.equal(set.status, "posted");
      assert.equal(set.generation, 1);
      assert.equal(set.fiscal_year_earnings, "500.1000");
      assert.equal(set.reason, REASON);
      assert.equal(set.generated_by, actors.adminId);
      const audit = await db.execute<{ action: string; actor_id: string; reason: string }>(
        sql`
      select action, actor_id, changes->>'reason' as reason from audit_log
       where org_id = ${org.orgId} and table_name = 'period_end_journal_sets' and row_id = ${generated!.setId}`,
        "objects",
      );
      assert.deepEqual(
        audit.map((row) => [row.action, row.actor_id, row.reason]),
        [["generate", actors.adminId, REASON]],
      );

      const rerun = await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      assert.deepEqual(rerun.generated, []);
      assert.deepEqual(rerun.unchanged, [
        { subsidiaryId: org.subsidiaryId, setId: generated!.setId },
      ]);
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId} and origin = 'closing'`,
            "objects",
          )
        )[0]!.n,
        1,
      );
      assert.deepEqual(
        await periodEndJournalCloseCheck(org.orgId, {
          periodId: december,
          bookId: org.bookId,
          subsidiaryIds: [],
        }),
        { count: 0, details: undefined },
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the income summary method closes through the summary account, which ends at zero",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org, { incomeSummary: true });
      const result = await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      assert.equal(result.generated[0]!.entryIds.length, 2);
      const balances = await balancesThrough(org, "2026-12-31");
      assert.equal(balances.get(year.incomeSummaryId) ?? "0.0000", "0.0000");
      assert.equal(balances.get(year.retainedEarningsId), "-550.1000");
      assert.equal(await incomeStatementTotal(org, "2026-12-31"), "0.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "balance-sheet closing zeroes the year-end balance sheet and the opening journal restores it in the next year",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org, { balanceSheetJournals: true });
      const before = await balancesThrough(org, "2026-12-31");
      const result = await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      assert.equal(result.generated[0]!.entryIds.length, 3);
      const yearEnd = await balancesThrough(org, "2026-12-31");
      for (const [accountId, amount] of yearEnd)
        assert.equal(amount, "0.0000", `account ${accountId} is closed at the year end`);
      const january = await balancesThrough(org, "2027-01-31");
      assert.equal(january.get(org.accounts.bank), before.get(org.accounts.bank));
      assert.equal(january.get(year.capitalId), before.get(year.capitalId));
      assert.equal(january.get(year.retainedEarningsId), "-550.1000");
      const opening = await db.execute<{ origin: string; period_id: string; posting_date: string }>(
        sql`
      select e.origin, e.period_id, e.posting_date::text as posting_date
        from period_end_journal_entries pe join journal_entries e on e.org_id = pe.org_id and e.id = pe.entry_id
       where pe.org_id = ${org.orgId} and pe.kind = 'opening'`,
        "objects",
      );
      assert.deepEqual(opening, [
        { origin: "opening", period_id: year.periods.get("2027-01"), posting_date: "2027-01-01" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a closed year refuses later postings by name in the kernel and in storage, and leaves later years and other entities open",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org);
      await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });

      const refused = await postScratchEntry(org, {
        actorId: actors.adminId,
        periodId: december,
        date: "2026-12-30",
        lines: [
          [year.rentId, "10.0000"],
          [org.accounts.bank, "-10.0000"],
        ],
      }).catch((error: unknown) => error);
      assert.ok(
        refused instanceof Error &&
          /closed for this period and accounting book by the period-end journals of fiscal year 2026/.test(
            refused.message,
          ),
      );
      const details = (refused as { details?: { kind: string; periodId: string; module: string } })
        .details;
      assert.deepEqual(
        details && { kind: details.kind, periodId: details.periodId, module: details.module },
        { kind: "period-closed", periodId: december, module: "gl" },
      );

      // Storage refuses the same posting when the kernel is bypassed.
      const entryId = randomUUID();
      await db.execute(sql`
      insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'PEJ-DIRECT', '2026-12-30', ${december}, 'draft', 'manual')`);
      await db.execute(sql`
      insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate)
      values (${org.orgId}, ${entryId}, 1, ${year.rentId}, ${org.subsidiaryId}, 10, 'CAD', 10, 1),
             (${org.orgId}, ${entryId}, 2, ${org.accounts.bank}, ${org.subsidiaryId}, -10, 'CAD', -10, 1)`);
      await assert.rejects(
        () =>
          db.execute(
            sql`update journal_entries set status = 'posted', posted_at = now() where org_id = ${org.orgId} and id = ${entryId}`,
          ),
        (error: unknown) =>
          /closed by its period-end journals/.test(
            String(
              (error as { cause?: { message?: string } }).cause?.message ??
                (error as Error).message,
            ),
          ),
      );

      // The next fiscal year is untouched.
      await postScratchEntry(org, {
        actorId: actors.adminId,
        periodId: year.periods.get("2027-01")!,
        date: "2027-01-05",
        lines: [
          [year.rentId, "10.0000"],
          [org.accounts.bank, "-10.0000"],
        ],
      });

      // Another legal entity of the same book is sealed only by its own generation.
      const branch = randomUUID();
      await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${branch}, ${org.orgId}, ${org.subsidiaryId}, 'Branch Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await postScratchEntry(org, {
        actorId: actors.adminId,
        periodId: december,
        date: "2026-12-30",
        subsidiaryId: branch,
        lines: [
          [year.rentId, "10.0000"],
          [org.accounts.bank, "-10.0000"],
        ],
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "the operator reverses a generation through the kernel before the year locks, and regeneration closes the corrected ledger",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org);
      const first = (
        await generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        })
      ).generated[0]!;

      await assert.rejects(
        () =>
          reversePeriodEndJournals(org.orgId, actors.adminId, {
            periodId: december,
            reason: "short",
          }),
        (error: unknown) =>
          error instanceof PeriodEndJournalError && error.code === "reason_required",
      );
      const reversal = await reversePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: "Late supplier invoice for December",
      });
      assert.equal(reversal.reversed.length, 1);
      const original = (
        await db.execute<{ status: string }>(
          sql`
      select status from journal_entries where org_id = ${org.orgId} and id = ${first.entryIds[0]!}`,
          "objects",
        )
      )[0]!;
      assert.equal(original.status, "reversed", "the original is marked reversed, never deleted");
      const mirror = await db.execute<{ origin: string; period_id: string }>(
        sql`
      select origin, period_id from journal_entries where org_id = ${org.orgId} and reverses_entry_id = ${first.entryIds[0]!}`,
        "objects",
      );
      assert.deepEqual(mirror, [{ origin: "closing", period_id: december }]);
      assert.equal(await incomeStatementTotal(org, "2026-12-31"), "-550.1000");

      // The late adjustment now posts, and regeneration closes it too.
      await postScratchEntry(org, {
        actorId: actors.adminId,
        periodId: december,
        date: "2026-12-30",
        lines: [
          [year.rentId, "25.0000"],
          [org.accounts.bank, "-25.0000"],
        ],
      });
      const second = (
        await generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        })
      ).generated[0]!;
      assert.equal(second.generation, 2);
      assert.equal(await incomeStatementTotal(org, "2026-12-31"), "0.0000");

      const history = await periodEndJournalHistory(org.orgId, { fiscalYear: 2026 });
      assert.deepEqual(
        history.map((entry) => [entry.generation, entry.status, entry.fiscalYearEarnings]),
        [
          [2, "posted", "475.1000"],
          [1, "reversed", "500.1000"],
        ],
      );
      assert.equal(history[1]!.reversalReason, "Late supplier invoice for December");
      assert.ok(history[1]!.entries.every((entry) => entry.reversalEntryId));
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a governed reopen admits only the year-end period and its approval reverses the journals",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org);
      await grantScratchPermissions(org.orgId, actors.approver1Id, ["close.reopen"]);
      await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      await closeScratchPeriods(org, actors.adminId, [december]);

      const july = year.periods.get("2026-07")!;
      await assert.rejects(
        () =>
          requestReviewedReopenFixture({
            orgId: org.orgId,
            periodId: july,
            bookId: org.bookId,
            modules: ["gl"],
            actorId: actors.adminId,
            reason: "Correct a July accrual",
          }),
        (error: unknown) =>
          error instanceof CloseError &&
          /request the reopen of P12 FY2026 first/.test(error.message),
      );
      const requestId = await requestReviewedReopenFixture({
        orgId: org.orgId,
        periodId: december,
        bookId: org.bookId,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Auditor adjustment to fiscal year 2026",
      });
      await decideReopenFixture({
        orgId: org.orgId,
        requestId,
        actorId: actors.approver1Id,
        decision: "approved",
        hours: 2,
      });

      const set = await db.execute<{
        status: string;
        reversed_by: string;
        reopen_request_id: string;
        reversal_reason: string;
      }>(
        sql`
      select status, reversed_by, reopen_request_id, reversal_reason from period_end_journal_sets where org_id = ${org.orgId}`,
        "objects",
      );
      assert.deepEqual(
        set.map((row) => [row.status, row.reversed_by, row.reopen_request_id]),
        [["reversed", actors.approver1Id, requestId]],
      );
      assert.match(set[0]!.reversal_reason, /Auditor adjustment to fiscal year 2026/);
      assert.equal(await incomeStatementTotal(org, "2026-12-31"), "-550.1000");

      // With the journals reversed, the rest of the year reopens normally.
      await requestReviewedReopenFixture({
        orgId: org.orgId,
        periodId: july,
        bookId: org.bookId,
        modules: ["gl"],
        actorId: actors.adminId,
        reason: "Correct a July accrual",
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("generation refuses an unready year by name and posts nothing", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await grantScratchPermissions(org.orgId, actors.adminId, ["close.run"]);
    const year = await seedPeriodEndYear(org);
    await postScratchYearActivity(org, year, actors.adminId);
    const december = year.periods.get("2026-12")!;

    await assert.rejects(
      () =>
        generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        }),
      (error: unknown) => error instanceof PeriodEndJournalError && error.code === "policy_missing",
    );
    await recordPeriodEndPolicy(org, year, { actorId: actors.adminId });

    // Every other period of the year is still open.
    const open = await generatePeriodEndJournals(org.orgId, actors.adminId, {
      periodId: december,
      reason: REASON,
    });
    assert.deepEqual(open.generated, []);
    assert.deepEqual(
      open.refused[0]!.problems.map((problem) => problem.code),
      ["periods_open"],
    );

    // A draft left in the year refuses as well, once the periods are closed.
    await closeScratchPeriods(org, actors.adminId, closedYearPeriods(year));
    await db.execute(sql`
      insert into journal_entries (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
      values (${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, 'PEJ-DRAFT', '2026-12-29', ${december}, 'draft', 'manual')`);
    const drafts = await generatePeriodEndJournals(org.orgId, actors.adminId, {
      periodId: december,
      reason: REASON,
    });
    assert.deepEqual(
      drafts.refused[0]!.problems.map((problem) => problem.code),
      ["drafts_open"],
    );
    assert.equal(
      (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from journal_entries where org_id = ${org.orgId} and origin in ('closing', 'opening')`,
          "objects",
        )
      )[0]!.n,
      0,
    );

    // The feature switch governs the command.
    await db.execute(
      sql`update orgs set settings = jsonb_set(settings, '{features,periodEndJournals}', 'false'::jsonb) where id = ${org.orgId}`,
    );
    await assert.rejects(
      () =>
        generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        }),
      (error: unknown) =>
        error instanceof PeriodEndJournalError && error.code === "feature_disabled",
    );
    // A user without the close permission is refused in the service.
    await db.execute(
      sql`update orgs set settings = jsonb_set(settings, '{features,periodEndJournals}', 'true'::jsonb) where id = ${org.orgId}`,
    );
    await assert.rejects(
      () =>
        generatePeriodEndJournals(org.orgId, actors.outsiderId, {
          periodId: december,
          reason: REASON,
        }),
      (error: unknown) => error instanceof PeriodEndJournalError && error.code === "forbidden",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "period-end readiness scopes unassigned documents by effective posting date",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, december } = await readyYear(org);
      const decemberEnd = (
        await db.execute<{ ends_on: string }>(
          sql`
      select ends_on::text as ends_on from accounting_periods
       where org_id = ${org.orgId} and id = ${december}`,
          "objects",
        )
      )[0]?.ends_on;
      assert.ok(decemberEnd);
      const id = randomUUID();
      await db.execute(sql`
      insert into documents (id,org_id,subsidiary_id,kind,status,document_number,document_date,posting_date,currency,subtotal,tax_total,total)
      values (${id},${org.orgId},${org.subsidiaryId},'vendor_bill','draft',${id},
              '2025-12-31',${decemberEnd},'CAD',10,0,10)`);

      const result = await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      assert.deepEqual(
        result.refused[0]!.problems.map((problem) => problem.code),
        ["drafts_open"],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "policy versions cannot reach back into a closed year and must name postable equity accounts",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org);
      assert.match(
        (await periodEndPolicyWriteRefusal(db, org.orgId, {
          effectiveFrom: "2027-01-01",
          closingMethod: "income_summary",
          retainedEarningsAccountId: year.retainedEarningsId,
          incomeSummaryAccountId: "-".repeat(36),
        })) ?? "",
        /Choose the income summary account/,
      );
      assert.match(
        (await periodEndPolicyWriteRefusal(db, org.orgId, {
          effectiveFrom: "2027-01-01",
          retainedEarningsAccountId: "-".repeat(36),
        })) ?? "",
        /Choose the retained earnings account/,
      );
      assert.match(
        (await periodEndPolicyWriteRefusal(db, org.orgId, {
          effectiveFrom: "2027-02-30",
          retainedEarningsAccountId: year.retainedEarningsId,
        })) ?? "",
        /valid effective date/,
      );
      assert.match(
        (await periodEndPolicyWriteRefusal(db, org.orgId, {
          effectiveFrom: "2027-01-01",
          closingMethod: "retained_earnings",
          retainedEarningsAccountId: org.accounts.revenue,
        })) ?? "",
        /active, postable equity account/,
      );
      await assert.rejects(() =>
        db.execute(sql`
      insert into period_end_journal_policies (org_id, effective_from, closing_method, retained_earnings_account_id, reason)
      values (${org.orgId}, '2027-01-01', 'retained_earnings', ${org.accounts.revenue}, 'Wrong account type')`),
      );

      await generatePeriodEndJournals(org.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });
      assert.match(
        (await periodEndPolicyWriteRefusal(db, org.orgId, {
          effectiveFrom: "2026-06-30",
          closingMethod: "retained_earnings",
          retainedEarningsAccountId: year.retainedEarningsId,
        })) ?? "",
        /Fiscal year 2026 is closed by period-end journals through 2026-12-31/,
      );
      await assert.rejects(() =>
        db.execute(sql`
      insert into period_end_journal_policies (org_id, effective_from, closing_method, retained_earnings_account_id, reason)
      values (${org.orgId}, '2026-06-30', 'retained_earnings', ${year.retainedEarningsId}, 'Reach back into a closed year')`),
      );
      assert.equal(
        await periodEndPolicyWriteRefusal(db, org.orgId, {
          effectiveFrom: "2027-01-01",
          closingMethod: "retained_earnings",
          retainedEarningsAccountId: year.retainedEarningsId,
        }),
        null,
      );
      // Recorded history is immutable.
      await assert.rejects(() =>
        db.execute(sql`
      update period_end_journal_policies set balance_sheet_journals = true where org_id = ${org.orgId}`),
      );
      await assert.rejects(() =>
        db.execute(sql`delete from period_end_journal_sets where org_id = ${org.orgId}`),
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "concurrent generations of the same year post exactly one generation",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, december } = await readyYear(org);
      const [left, right] = await Promise.all([
        generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        }),
        generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        }),
      ]);
      assert.equal(left.generated.length + right.generated.length, 1);
      assert.equal(left.unchanged.length + right.unchanged.length, 1);
      const sets = (
        await db.execute<{ n: number }>(
          sql`
      select count(*)::int as n from period_end_journal_sets where org_id = ${org.orgId}`,
          "objects",
        )
      )[0]!.n;
      assert.equal(sets, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "organizations are isolated: one tenant's closed year neither seals nor appears in another",
  { skip: !DB },
  async () => {
    const closed = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const { actors, december } = await readyYear(closed);
      await generatePeriodEndJournals(closed.orgId, actors.adminId, {
        periodId: december,
        reason: REASON,
      });

      const otherActors = await seedFlowActors(other.orgId);
      const otherYear = await seedPeriodEndYear(other);
      await postScratchEntry(other, {
        actorId: otherActors.adminId,
        periodId: otherYear.periods.get("2026-12")!,
        date: "2026-12-30",
        lines: [
          [otherYear.rentId, "10.0000"],
          [other.accounts.bank, "-10.0000"],
        ],
      });
      assert.deepEqual(await periodEndJournalHistory(other.orgId, {}), []);
      // A foreign organization's period identifier is unknown here.
      await assert.rejects(
        () => previewPeriodEndJournals(other.orgId, { periodId: december }),
        (error: unknown) => error instanceof PeriodEndJournalError && error.code === "not_found",
      );
      assert.equal((await periodEndJournalHistory(closed.orgId, {})).length, 1);
    } finally {
      await dropScratchOrg(closed.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);

test(
  "the seal exempts only the reversal of the generation's own journals",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { actors, year, december } = await readyYear(org);
      const generated = (
        await generatePeriodEndJournals(org.orgId, actors.adminId, {
          periodId: december,
          reason: REASON,
        })
      ).generated[0]!;
      const gate = (reversesEntryId: string | null) =>
        assertPeriodModulesOpen(db, {
          orgId: org.orgId,
          periodId: december,
          bookId: org.bookId,
          subsidiaryIds: [org.subsidiaryId],
          modules: [],
          reversesEntryId,
        });
      await gate(generated.entryIds[0]!);
      const ordinary = await postScratchEntry(org, {
        actorId: actors.adminId,
        periodId: year.periods.get("2027-01")!,
        date: "2027-01-03",
        lines: [
          [year.rentId, "1.0000"],
          [org.accounts.bank, "-1.0000"],
        ],
      });
      const refused = await gate(ordinary).catch((failure: unknown) => failure);
      assert.ok(refused instanceof PeriodClosedError);
      assert.equal(refused.details.periodId, december);
      const unrelated = await gate(null).catch((failure: unknown) => failure);
      assert.ok(unrelated instanceof PeriodClosedError);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
