import { sql } from "drizzle-orm";
import { auditBankingModuleClose, evaluateBankingModuleClose } from "../close/banking-close.ts";
import { generateAccountingPeriods } from "../close/calendar.ts";
import { recordEquityAccountPolicy } from "../equity/account-policy.ts";
import { buildCapTable, eventCeiling, holdingState } from "../equity/cap-table.ts";
import { compensationRunChange, postCompensationRun } from "../equity/compensation-run.ts";
import { recordSecurityEvent, type RecordEventInput } from "../equity/events.ts";
import { interestRunChange, postInterestRun } from "../equity/interest-run.ts";
import { electMfnTerms } from "../equity/mfn.ts";
import { issueSecurity, type IssueSecurityInput } from "../equity/securities.ts";
import { loadEquityBook } from "../equity/store.ts";
import {
  amendShareClass,
  changePlanReserve,
  createPlan,
  createRound,
  createShareClass,
} from "../equity/structure.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { closePeriodAllModules } from "../periods/period-locks.ts";
import { businessTodayInTx } from "../platform/business-date.ts";
import { addMonthsClamped, endOfMonth } from "../platform/civil-date.ts";
import { db } from "../platform/db.ts";
import {
  OPTION_GRANTS,
  PRICED_ROUNDS,
  RSU_AWARDS,
  storyDate,
  type StoryDate,
} from "./cap-table-story.ts";
import { SampleCompanyError } from "./provisioning-failures.ts";
import { scenarioRecordId, type DemoContext } from "./scenarios.ts";

const INCORPORATION: StoryDate = [-3, "03-01"];
const NOTE_ISSUE: StoryDate = [-2, "01-16"];
const PRE_LEDGER_CLOSE_REASON =
  "Close the pre-operating years after recording the company's equity financing history";
const PRE_LEDGER_BANKING_ACKNOWLEDGEMENT =
  "These years carry only the financing proceeds of the equity history; bank statements begin with the operating ledger.";
const OPTION_VALUATION = {
  volatilityPercent: "55",
  expectedTermYears: "6.08",
  dividendYieldPercent: "0",
} as const;

/**
 * A three-year venture-backed cap table recorded through the native equity
 * commands, in date order, so every validation runs against the history as
 * it stood: incorporation with restricted founder stock and 83(b)
 * elections, the equity incentive plan and its reserve increases, two SAFEs
 * (one post-money with a cap, one MFN that adopts the convertible note's
 * terms), the note and its monthly interest runs, the Series Seed that
 * converts them after a pre-money pool top-up, a common charter amendment,
 * the Series A, a lender warrant, employee options and RSUs, an ordinary and
 * an early exercise, a departure whose unvested options are forfeited and
 * whose vested options expire, a forfeiture recorded in error and reversed,
 * and monthly stock compensation runs. Every step replays by its request key
 * or its recorded identity, and nothing is dated after the business day.
 *
 * Postings need open accounting periods. Years of the story before the
 * operating ledger's first fiscal year receive their periods through the
 * calendar's native generation; once the history they carry is recorded they
 * are closed through the native period close, so later activity can never
 * reinterpret them. Stock compensation runs are measured each month-end
 * whose period is open; a closed month is measured cumulatively by the next
 * open one.
 */
export async function installCapTable(c: DemoContext): Promise<void> {
  // Member companies keep the cap table their source carried.
  if (c.memberSample) return;
  const at = (date: StoryDate) => storyDate(c.year, date);
  const today = await businessTodayInTx(db, c.orgId);
  const start = at(INCORPORATION);
  const command = { orgId: c.orgId, actorId: c.actorId, subsidiaryId: c.subsidiaryId };
  const account = (key: string) => scenarioRecordId(c, "accounts", key);
  const party = (key: string) => scenarioRecordId(c, "parties", key);
  const cash = account("financing-bank");
  const key = (name: string) => `industry-demo:${c.orgId}:equity:${name}`;
  const one = async <T extends Record<string, unknown>>(
    query: ReturnType<typeof sql>,
  ): Promise<T | undefined> => (await db.execute(query, "objects"))[0] as T | undefined;
  const awaitingApproval = (what: string) =>
    new SampleCompanyError(
      `The demonstration ${what} awaits approval; review the Equity action Flow before preparing the master.`,
    );

  const policies = await db.execute<{ effective_from: string }>(
    sql`
    select effective_from::text as effective_from from equity_account_policies where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId}`,
    "objects",
  );
  if (policies.length && !policies.some((row) => row.effective_from === start)) {
    throw new SampleCompanyError(
      `This master carries an earlier cap table demonstration whose equity accounts take effect after ${start}. Prepare a fresh synthetic master to install the current cap table history.`,
    );
  }
  const generated = await openPreLedgerYears(c, start);

  const securityId = async (name: string): Promise<string> => {
    const row = await one<{ id: string }>(
      sql`select id from equity_securities where org_id = ${c.orgId} and idempotency_key = ${key(name)}`,
    );
    if (!row)
      throw new SampleCompanyError(
        `The demonstration security ${name} could not be read back; review the cap table before preparing the master again.`,
      );
    return row.id;
  };
  const recordedEvent = async (
    name: string,
  ): Promise<{ id: string; resulting_security_id: string | null }> => {
    const row = await one<{ id: string; resulting_security_id: string | null }>(sql`
      select id, resulting_security_id from equity_security_events where org_id = ${c.orgId} and idempotency_key = ${key(name)}`);
    if (!row)
      throw new SampleCompanyError(
        `The demonstration event ${name} could not be read back; review the security's history before preparing the master again.`,
      );
    return row;
  };
  const classId = async (code: string) =>
    (
      await one<{ id: string }>(sql`
    select id from equity_share_classes where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId} and code = ${code}`)
    )?.id;
  const planId = async (): Promise<string> => {
    const row = await one<{ id: string }>(
      sql`select id from equity_plans where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId} and code = 'EIP'`,
    );
    if (!row)
      throw new SampleCompanyError(
        "The demonstration equity incentive plan could not be read back.",
      );
    return row.id;
  };
  const issue = (
    name: string,
    input: Omit<IssueSecurityInput, "orgId" | "actorId" | "subsidiaryId" | "idempotencyKey">,
  ) => issueSecurity({ ...command, ...input, idempotencyKey: key(name) });
  const event = async (
    name: string,
    input: Omit<RecordEventInput, "orgId" | "actorId" | "idempotencyKey">,
  ) => {
    const result = await recordSecurityEvent({
      orgId: c.orgId,
      actorId: c.actorId,
      ...input,
      idempotencyKey: key(name),
    });
    if (result.status !== "applied") throw awaitingApproval(`${input.kind} of ${name}`);
    return result;
  };
  /** Units of an award a departure or correction acts on, as the native holding replay measures them. */
  const holding = async (name: string, on: string, measure: "unvested" | "vestedAvailable") => {
    const id = await securityId(name);
    const book = await loadEquityBook(db, c.orgId, c.subsidiaryId);
    const security = book.securities.find((row) => row.id === id)!;
    return eventCeiling(
      book,
      security,
      holdingState(book, security, on).exact[measure],
      on,
    ).toString();
  };
  const reserveChange = async (date: string, shareDelta: string, reason: string) => {
    const plan = await planId();
    if (
      await one(
        sql`select id from equity_plan_reserve_changes where org_id = ${c.orgId} and plan_id = ${plan} and effective_on = ${date}::date and share_delta = ${shareDelta}::bigint`,
      )
    )
      return;
    const change = await changePlanReserve({
      orgId: c.orgId,
      actorId: c.actorId,
      planId: plan,
      effectiveOn: date,
      shareDelta,
      reason,
    });
    if (change.status !== "applied") throw awaitingApproval("plan reserve change");
  };
  const policy = async (
    effectiveFrom: string,
    accounts: Record<string, string>,
    reason: string,
  ) => {
    if (
      await one(
        sql`select id from equity_account_policies where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId} and effective_from = ${effectiveFrom}::date`,
      )
    )
      return;
    const version = await recordEquityAccountPolicy({
      ...command,
      effectiveFrom,
      commonStockAccountId: account("common-stock"),
      preferredStockAccountId: account("preferred-stock"),
      apicAccountId: account("apic"),
      apicShareBasedAccountId: account("apic-share-based"),
      compensationExpenseAccountId: account("stock-compensation"),
      treasuryStockAccountId: account("treasury-stock"),
      convertibleInstrumentsAccountId: account("convertible-instruments"),
      ...accounts,
      reason,
    });
    if (version.status !== "applied") throw awaitingApproval("equity account policy");
  };
  const pricedRound = async (
    round: (typeof PRICED_ROUNDS)["seed" | "seriesA"],
    converting: readonly string[],
  ) => {
    const closed = at(round.closed);
    const preferred =
      (await classId(round.classCode)) ??
      (
        await createShareClass({
          ...command,
          code: round.classCode,
          name: round.className,
          kind: "preferred",
          effectiveOn: closed,
          authorizedShares: round.authorizedShares,
          parValue: "0.0001",
          originalIssuePrice: round.price,
          liquidationMultiple: "1",
          participation: "none",
          seniority: round.seniority,
          antiDilution: "broad_based",
          conversionShareClassId: await classId("CS"),
        })
      ).id;
    let roundId = (
      await one<{ id: string }>(sql`
      select id from equity_financing_rounds where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId} and name = ${round.name}`)
    )?.id;
    if (!roundId) {
      // The pre-money valuation is the fully diluted capitalization before the round, at the round price.
      const before = buildCapTable(await loadEquityBook(db, c.orgId, c.subsidiaryId), closed);
      const preMoneyValuation = fromUnits(
        toUnits(round.price) * BigInt(before.totals.fullyDiluted),
      );
      roundId = (
        await createRound({
          ...command,
          name: round.name,
          shareClassId: preferred,
          closedOn: closed,
          pricePerShare: round.price,
          preMoneyValuation,
        })
      ).id;
    }
    for (const name of converting) {
      await event(`${name}:conversion`, {
        securityId: await securityId(name),
        kind: "convert",
        effectiveOn: closed,
        roundId,
        reason: `Converted in the ${round.name}`,
      });
    }
    for (const investor of round.investors) {
      await issue(`round:${round.classCode}:${investor.key}`, {
        kind: "share",
        holderPartyId: party(investor.holder),
        issueDate: closed,
        shareClassId: preferred,
        roundId,
        quantity: investor.shares,
        considerationAccountId: cash,
        memo: `${round.name} new-money investment`,
      });
    }
  };

  const steps: { on: string; run: () => Promise<unknown> }[] = [];
  const on = (date: string, run: () => Promise<unknown>) => steps.push({ on: date, run });

  // Incorporation: common stock, restricted founder stock and the founders' 83(b) elections.
  on(start, () => policy(start, {}, "Equity accounts for the legal entity's cap table"));
  on(start, async () => {
    if (!(await classId("CS")))
      await createShareClass({
        ...command,
        code: "CS",
        name: "Common Stock",
        kind: "common",
        effectiveOn: start,
        authorizedShares: "20000000",
        parValue: "0.0001",
      });
  });
  for (const [founder, shares] of [
    ["founder-1", "4500000"],
    ["founder-2", "3600000"],
  ] as const) {
    on(start, async () =>
      issue(founder, {
        kind: "share",
        holderPartyId: party(founder),
        issueDate: start,
        shareClassId: await classId("CS"),
        quantity: shares,
        pricePerShare: "0.0001",
        considerationAccountId: cash,
        vestingStart: start,
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "monthly",
        memo: "Founder restricted common stock purchased at par, vesting over four years",
      }),
    );
    on(at([-3, "03-20"]), async () =>
      event(`${founder}:83b`, {
        securityId: await securityId(founder),
        kind: "election_83b",
        effectiveOn: at([-3, "03-20"]),
        reason: "The founder filed an 83(b) election on the restricted stock",
      }),
    );
  }
  on(at([-3, "04-03"]), async () => {
    if (
      await one(
        sql`select id from equity_plans where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId} and code = 'EIP'`,
      )
    )
      return;
    await createPlan({
      ...command,
      code: "EIP",
      name: "Equity Incentive Plan",
      shareClassId: (await classId("CS"))!,
      effectiveOn: at([-3, "04-03"]),
      reservedShares: "1500000",
      recycleForfeited: true,
      recycleExpired: true,
      recycleRepurchased: false,
    });
  });
  on(at([-3, "05-15"]), () =>
    issue("seed-safe", {
      kind: "safe",
      holderPartyId: party("seed-investor"),
      issueDate: at([-3, "05-15"]),
      considerationAmount: "1000000",
      considerationAccountId: cash,
      safeType: "post_money",
      valuationCap: "10000000",
      memo: "Post-money SAFE with a $10M valuation cap",
    }),
  );
  on(at([-3, "09-12"]), () =>
    issue("mfn-safe", {
      kind: "safe",
      holderPartyId: party("angel-investor"),
      issueDate: at([-3, "09-12"]),
      considerationAmount: "250000",
      considerationAccountId: cash,
      safeType: "post_money",
      mfn: true,
      memo: "Uncapped most-favored-nation SAFE from an angel investor",
    }),
  );

  // The convertible note, the MFN election that adopts its terms, and an early exercise with its 83(b) election.
  on(at([-2, "01-01"]), () =>
    policy(
      at([-2, "01-01"]),
      {
        interestExpenseAccountId: account("note-interest"),
        accruedInterestAccountId: account("accrued-note-interest"),
        earlyExerciseDepositAccountId: account("early-exercise-deposits"),
      },
      "Map convertible note interest and early-exercise deposits ahead of the note financing",
    ),
  );
  const noteIssue = at(NOTE_ISSUE);
  on(noteIssue, () =>
    issue("convertible-note", {
      kind: "note",
      holderPartyId: party("note-investor"),
      issueDate: noteIssue,
      considerationAmount: "500000",
      considerationAccountId: cash,
      interestRatePercent: "6",
      interestBasis: "simple",
      interestDayCount: "actual_365",
      maturityDate: storyDate(c.year, [0, "01-16"]),
      valuationCap: "12000000",
      discountPercent: "20",
      memo: "Two-year 6% convertible note with a $12M cap and a 20% discount",
    }),
  );
  on(at([-2, "02-01"]), async () => {
    const election = await electMfnTerms({
      orgId: c.orgId,
      actorId: c.actorId,
      securityId: await securityId("mfn-safe"),
      sourceSecurityId: await securityId("convertible-note"),
      effectiveOn: at([-2, "02-01"]),
      reason: "The holder adopted the convertible note's cap and discount under the MFN term",
      idempotencyKey: key("mfn-safe:election"),
    });
    if (election.status !== "applied") throw awaitingApproval("MFN election");
  });
  on(at([-2, "03-18"]), async () =>
    event("option:maya:exercise", {
      securityId: await securityId("option:maya"),
      kind: "exercise",
      effectiveOn: at([-2, "03-18"]),
      quantity: "288000",
      considerationAccountId: cash,
    }),
  );
  on(at([-2, "04-02"]), async () => {
    const exercise = await recordedEvent("option:maya:exercise");
    if (!exercise.resulting_security_id)
      throw new SampleCompanyError("The demonstration early exercise produced no certificate.");
    await event("option:maya:certificate:83b", {
      securityId: exercise.resulting_security_id,
      kind: "election_83b",
      effectiveOn: at([-2, "04-02"]),
      reason: "The holder filed an 83(b) election on the early-exercised shares",
    });
  });

  // The Series Seed: a pre-money pool top-up, then the SAFEs and the note convert alongside the new money.
  on(at([-2, "06-14"]), () =>
    reserveChange(
      at([-2, "06-14"]),
      "1000000",
      "Board approved the pre-money option pool increase required by the Series Seed term sheet",
    ),
  );
  on(at(PRICED_ROUNDS.seed.closed), () =>
    pricedRound(PRICED_ROUNDS.seed, ["seed-safe", "mfn-safe", "convertible-note"]),
  );
  on(at([-2, "09-16"]), async () =>
    event("option:diego:exercise", {
      securityId: await securityId("option:diego"),
      kind: "exercise",
      effectiveOn: at([-2, "09-16"]),
      quantity: "60000",
      considerationAccountId: cash,
    }),
  );

  // A departure: unvested options are forfeited and the vested ones expire after the post-termination window.
  on(at([-1, "04-30"]), async () =>
    event("option:liam:forfeit", {
      securityId: await securityId("option:liam"),
      kind: "forfeit",
      effectiveOn: at([-1, "04-30"]),
      quantity: await holding("option:liam", at([-1, "04-30"]), "unvested"),
      reason: "Employment ended; the unvested options return to the plan",
    }),
  );
  on(at([-1, "07-29"]), async () =>
    event("option:liam:expire", {
      securityId: await securityId("option:liam"),
      kind: "expire",
      effectiveOn: at([-1, "07-29"]),
      quantity: await holding("option:liam", at([-1, "07-29"]), "vestedAvailable"),
      reason: "The 90-day post-termination exercise window closed",
    }),
  );
  // A forfeiture recorded against the wrong employee, undone by the governed reversal of that one event.
  on(at([-1, "08-15"]), async () =>
    event("option:sofia:forfeit", {
      securityId: await securityId("option:sofia"),
      kind: "forfeit",
      effectiveOn: at([-1, "08-15"]),
      quantity: await holding("option:sofia", at([-1, "08-15"]), "unvested"),
      reason: "Employment ended per the offboarding queue",
    }),
  );
  on(at([-1, "08-20"]), async () =>
    event("option:sofia:forfeit:reversal", {
      securityId: await securityId("option:sofia"),
      kind: "reverse",
      effectiveOn: at([-1, "08-20"]),
      reversesEventId: (await recordedEvent("option:sofia:forfeit")).id,
      reason: "The offboarding record belonged to another employee; Sofia Rossi remains employed",
    }),
  );

  // The Series A: the charter raises authorized common, the pool is refreshed, the round closes, and the lender takes a warrant.
  on(at([-1, "09-15"]), async () => {
    const common = (await classId("CS"))!;
    if (
      await one(
        sql`select id from equity_class_amendments where org_id = ${c.orgId} and share_class_id = ${common} and kind = 'authorized_shares' and effective_on = ${at([-1, "09-15"])}::date`,
      )
    )
      return;
    const amendment = await amendShareClass({
      orgId: c.orgId,
      actorId: c.actorId,
      shareClassId: common,
      kind: "authorized_shares",
      effectiveOn: at([-1, "09-15"]),
      authorizedShares: "30000000",
      reason:
        "Charter amendment ahead of the Series A raises authorized common stock to 30,000,000 shares",
    });
    if (amendment.status !== "applied") throw awaitingApproval("class amendment");
  });
  on(at([-1, "09-15"]), () =>
    reserveChange(
      at([-1, "09-15"]),
      "1000000",
      "Board approved the option pool refresh in the Series A financing",
    ),
  );
  on(at(PRICED_ROUNDS.seriesA.closed), () => pricedRound(PRICED_ROUNDS.seriesA, []));
  on(at([-1, "11-14"]), async () =>
    issue("lender-warrant", {
      kind: "warrant",
      holderPartyId: party("venture-lender"),
      issueDate: at([-1, "11-14"]),
      shareClassId: await classId(PRICED_ROUNDS.seriesA.classCode),
      quantity: "46875",
      pricePerShare: PRICED_ROUNDS.seriesA.price,
      expirationDate: storyDate(c.year + 10, [-1, "11-14"]),
      memo: "Warrant issued with the $5M venture debt facility",
    }),
  );

  // Employee awards: incentive stock options at the grant date's fair market value, and RSUs.
  for (const grant of OPTION_GRANTS) {
    const granted = at(grant.granted);
    on(granted, async () =>
      issue(`option:${grant.key}`, {
        kind: "option",
        holderPartyId: party(grant.holder),
        issueDate: granted,
        shareClassId: await classId("CS"),
        planId: await planId(),
        quantity: grant.shares,
        pricePerShare: grant.strike,
        optionType: "iso",
        expirationDate: storyDate(c.year + 10, grant.granted),
        vestingStart: granted,
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "monthly",
        ...(grant.earlyExercise
          ? { earlyExercise: true, unvestedRepurchaseBasis: "cost" as const }
          : {}),
        valuation: {
          sharePrice: grant.strike,
          riskFreeRatePercent: grant.riskFreeRatePercent,
          ...OPTION_VALUATION,
          attribution: "straight_line",
        },
        memo: "Incentive stock option granted at the board-approved fair market value",
      }),
    );
  }
  for (const award of RSU_AWARDS) {
    const granted = at(award.granted);
    on(granted, async () =>
      issue(`rsu:${award.key}`, {
        kind: "rsu",
        holderPartyId: party(award.holder),
        issueDate: granted,
        shareClassId: await classId("CS"),
        planId: await planId(),
        quantity: award.shares,
        vestingStart: granted,
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "quarterly",
        valuation: { sharePrice: award.sharePrice, attribution: "straight_line" },
        memo: "Restricted stock units vesting quarterly over four years",
      }),
    );
  }

  // Steps run in date order (recording order within a day); each month-end's runs post before the next month's steps.
  const periodOpen = (date: string) => accountingPeriodOpen(c, date);
  const seedClose = at(PRICED_ROUNDS.seed.closed);
  let monthEnd = endOfMonth(OPTION_GRANTS.map((grant) => at(grant.granted)).sort()[0]!);
  const runMonthEnds = async (before: string) => {
    for (
      ;
      monthEnd < before && monthEnd <= today;
      monthEnd = endOfMonth(addMonthsClamped(`${monthEnd.slice(0, 7)}-01`, 1))
    ) {
      if (monthEnd > noteIssue && monthEnd < seedClose)
        await monthlyRun(c, "interest", monthEnd, periodOpen);
      await monthlyRun(c, "compensation", monthEnd, periodOpen);
    }
  };
  for (const { on: date, run } of steps
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : a.index - b.index))) {
    if (date > today) break;
    await runMonthEnds(date);
    await run();
  }
  await runMonthEnds("9999-12-31");
  await closePreLedgerYears(c, generated);
}

/** Whether an open period of the default calendar covers the date. */
async function accountingPeriodOpen(c: DemoContext, date: string): Promise<boolean> {
  return (
    (
      await db.execute(
        sql`
    select 1 from accounting_periods p
     where p.org_id = ${c.orgId} and not p.is_adjustment and ${date}::date between p.starts_on and p.ends_on
       and p.fiscal_calendar_id in (select id from fiscal_calendars where org_id = ${c.orgId} and is_default and is_active)
       and not exists (select 1 from period_locks l where l.org_id = p.org_id and l.period_id = p.id and l.state <> 'open')`,
        "objects",
      )
    ).length > 0
  );
}

/**
 * Generate the accounting periods of story years that precede the operating
 * ledger's first fiscal year, through the calendar's native generation. A
 * year that already carries periods is left as it stands.
 */
async function openPreLedgerYears(c: DemoContext, start: string): Promise<string[]> {
  const calendar = (
    await db.execute<{ id: string; year_start_month: number; first_year: number | null }>(
      sql`
    select c.id, c.year_start_month,
           (select min(p.fiscal_year) from accounting_periods p where p.org_id = c.org_id and p.fiscal_calendar_id = c.id) as first_year
      from fiscal_calendars c where c.org_id = ${c.orgId} and c.is_default and c.is_active`,
      "objects",
    )
  )[0];
  if (!calendar)
    throw new SampleCompanyError(
      "The demonstration needs an active default fiscal calendar before its equity history can be recorded.",
    );
  const firstYear = calendar.first_year ?? c.year;
  const years: number[] = [];
  for (let year = Number(start.slice(0, 4)); year < Math.min(firstYear, c.year); year++)
    years.push(year);
  if (!years.length) return [];
  if (calendar.year_start_month !== 1) {
    throw new SampleCompanyError(
      "The equity history spans calendar years before the operating ledger, but the default fiscal calendar does not start in January. Generate those fiscal years in Period Close before preparing the master.",
    );
  }
  const generated: string[] = [];
  for (const year of years) {
    const existing = await db.execute(
      sql`select 1 from accounting_periods where org_id = ${c.orgId} and fiscal_calendar_id = ${calendar.id} and fiscal_year = ${year} limit 1`,
      "objects",
    );
    if (existing.length) continue;
    await generateAccountingPeriods(c.orgId, calendar.id, year, c.actorId);
    const periods = await db.execute<{ id: string }>(
      sql`
      select id from accounting_periods where org_id = ${c.orgId} and fiscal_calendar_id = ${calendar.id} and fiscal_year = ${year} order by starts_on, is_adjustment`,
      "objects",
    );
    if (!periods.length)
      throw new SampleCompanyError(
        `Fiscal year ${year} could not be generated for the equity history; review the default calendar in Period Close.`,
      );
    generated.push(...periods.map((row) => row.id));
  }
  return generated;
}

/** Close the generated pre-operating periods in every active book, every module, GL last. */
async function closePreLedgerYears(c: DemoContext, periodIds: readonly string[]): Promise<void> {
  if (!periodIds.length) return;
  const books = await db.execute<{ id: string }>(
    sql`select id from accounting_books where org_id = ${c.orgId} and is_active order by id`,
    "objects",
  );
  for (const periodId of periodIds) {
    for (const book of books) {
      const banking = await evaluateBankingModuleClose(c.orgId, {
        periodId,
        bookId: book.id,
        actorId: c.actorId,
        acknowledgement: PRE_LEDGER_BANKING_ACKNOWLEDGEMENT,
      });
      const { results } = await closePeriodAllModules({
        orgId: c.orgId,
        periodId,
        bookId: book.id,
        actorId: c.actorId,
        reason: PRE_LEDGER_CLOSE_REASON,
      });
      const failed = results.find((result) => !result.ok);
      if (failed)
        throw new SampleCompanyError(
          `A pre-operating period of the equity history could not be closed (${failed.module}: ${failed.error}). Review the period in Period Close before preparing the master.`,
        );
      if (banking.issues.length) {
        await auditBankingModuleClose(c.orgId, {
          periodId,
          bookId: book.id,
          actorId: c.actorId,
          reason: PRE_LEDGER_CLOSE_REASON,
          acknowledgement: PRE_LEDGER_BANKING_ACKNOWLEDGEMENT,
          evaluation: banking,
        });
      }
    }
  }
}

/**
 * Post one month-end's stock compensation or note interest run. Runs are
 * sequential: a month already measured replays, a month whose period is
 * closed is measured by the next open month-end, and a month with nothing
 * due posts no run.
 */
async function monthlyRun(
  c: DemoContext,
  kind: "compensation" | "interest",
  through: string,
  periodOpen: (date: string) => Promise<boolean>,
): Promise<void> {
  const table = kind === "compensation" ? sql`equity_compensation_runs` : sql`equity_interest_runs`;
  const runs = (
    await db.execute<{ last: string | null; recorded: boolean }>(
      sql`
    select max(through_date)::text as last, bool_or(through_date = ${through}::date) as recorded
      from ${table} where org_id = ${c.orgId} and subsidiary_id = ${c.subsidiaryId}`,
      "objects",
    )
  )[0];
  if (runs?.recorded || (runs?.last && runs.last >= through) || !(await periodOpen(through)))
    return;
  const input = {
    orgId: c.orgId,
    actorId: c.actorId,
    subsidiaryId: c.subsidiaryId,
    throughDate: through,
  };
  const due =
    kind === "compensation"
      ? await compensationRunChange(c.orgId, c.subsidiaryId, through).then(
          (change) => /[1-9]/.test(change.expense) || change.releaseLines > 0,
        )
      : await interestRunChange(c.orgId, c.subsidiaryId, through).then(
          (change) => change.lines > 0,
        );
  if (!due) return;
  const run =
    kind === "compensation" ? await postCompensationRun(input) : await postInterestRun(input);
  if (run.status !== "applied")
    throw new SampleCompanyError(
      `The demonstration ${kind} run through ${through} awaits approval; review the Equity action Flow before preparing the master.`,
    );
}
