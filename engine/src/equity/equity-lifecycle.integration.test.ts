import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { withSimClock } from "../platform/clock.ts";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  accountBalance,
  applied,
  entryLines,
  equityRefusal as refusal,
  linesBalance,
  seedEquityPolicy,
  seedHolder,
  seedSpotRate,
  setupEquityWorld,
  type EquityWorld,
} from "../testing/equity-world.ts";
import { postCompensationRun } from "./compensation-run.ts";
import type { EquityError } from "./errors.ts";
import { recordSecurityEvent } from "./events.ts";
import { postInterestRun, previewInterestRun } from "./interest-run.ts";
import { electMfnTerms } from "./mfn.ts";
import { loadCapTableView, loadSecurityDetail, loadStructure } from "./read-model.ts";
import { issueSecurity } from "./securities.ts";
import {
  amendShareClass,
  createPlan,
  createRound,
  createShareClass,
  recordSplit,
} from "./structure.ts";
import { loadEquityOverview } from "./overview.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const manage = (w: EquityWorld) => ({ orgId: w.org.orgId, actorId: w.managerId });
const approve = (w: EquityWorld) => ({ orgId: w.org.orgId, actorId: w.approverId });
const entity = (w: EquityWorld) => ({ ...manage(w), subsidiaryId: w.org.subsidiaryId });

async function preferredClass(w: EquityWorld, code = "SA"): Promise<string> {
  return (
    await createShareClass({
      ...entity(w),
      code,
      name: `Series ${code}`,
      kind: "preferred",
      effectiveOn: "2026-01-01",
      authorizedShares: "5000000",
      parValue: "0.0001",
      originalIssuePrice: "1.0000",
      conversionShareClassId: w.commonClassId,
    })
  ).id;
}

async function safe(w: EquityWorld, overrides: Partial<Parameters<typeof issueSecurity>[0]> = {}) {
  return issueSecurity({
    ...entity(w),
    kind: "safe",
    holderPartyId: w.holderId,
    issueDate: "2026-07-01",
    considerationAmount: "100000",
    considerationAccountId: w.org.accounts.bank,
    safeType: "post_money",
    ...overrides,
  });
}

async function note(w: EquityWorld, overrides: Partial<Parameters<typeof issueSecurity>[0]> = {}) {
  return issueSecurity({
    ...entity(w),
    kind: "note",
    holderPartyId: w.holderId,
    issueDate: "2026-07-01",
    considerationAmount: "100000",
    considerationAccountId: w.org.accounts.bank,
    interestRatePercent: "8",
    interestBasis: "simple",
    interestDayCount: "actual_365",
    ...overrides,
  });
}

test(
  "an MFN SAFE adopts a later SAFE's better terms by a recorded election and converts on them",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await issueSecurity({
        ...entity(w),
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "1000000",
        pricePerShare: "0.0001",
        considerationAccountId: w.org.accounts.bank,
      });
      const angel = await seedHolder(w.org.orgId, "Angel Investor");
      const mfn = await safe(w, { holderPartyId: angel, issueDate: "2026-07-02", mfn: true });
      const later = await safe(w, {
        issueDate: "2026-07-10",
        considerationAmount: "50000",
        valuationCap: "2000000",
        discountPercent: "20",
      });
      const detail = await loadSecurityDetail({
        ...manage(w),
        securityId: mfn.id,
        asOf: "2026-07-12",
      });
      assert.deepEqual(
        detail.mfn?.candidates.map((row) => [row.sourceSecurityId, row.improves]),
        [[later.id, ["cap", "discount"]]],
      );
      const election = {
        securityId: mfn.id,
        sourceSecurityId: later.id,
        effectiveOn: "2026-07-12",
        reason: "Holder elected the Seed SAFE terms",
        idempotencyKey: `mfn-${randomUUID()}`,
      };
      await assert.rejects(
        electMfnTerms({ ...approve(w), ...election }),
        refusal("equity_forbidden"),
        "the approval grant alone cannot record an election",
      );
      const elected = await electMfnTerms({ ...manage(w), ...election });
      assert.equal(elected.replayed, false);
      assert.equal(
        (await electMfnTerms({ ...manage(w), ...election })).replayed,
        true,
        "a retried election returns the one recorded",
      );
      await assert.rejects(
        electMfnTerms({ ...manage(w), ...election, idempotencyKey: null }),
        refusal("equity_mfn_not_better"),
        "terms already adopted are not better",
      );
      const audit = (
        await db.execute<{ n: string }>(
          sql`
      select count(*)::text as n from audit_log where org_id = ${w.org.orgId} and row_id = ${mfn.id} and action = 'equity.mfn.elect'`,
          "objects",
        )
      )[0]!;
      assert.equal(audit.n, "1");

      const seriesSeed = await preferredClass(w);
      const round = await createRound({
        ...entity(w),
        name: "Seed",
        shareClassId: seriesSeed,
        closedOn: "2026-07-20",
        pricePerShare: "1.00",
        preMoneyValuation: "1000000",
      });
      const converted = await recordSecurityEvent({
        ...manage(w),
        securityId: mfn.id,
        kind: "convert",
        effectiveOn: "2026-07-20",
        roundId: round.id,
      });
      // The adopted 20% discount prices the conversion at 0.80: 100,000 / 0.80 shares.
      const certificate = await loadSecurityDetail({
        ...manage(w),
        securityId: converted.resultingSecurityId!,
        asOf: "2026-07-20",
      });
      assert.equal(certificate.security.quantity, "125000");
      assert.equal(String(certificate.security.price_per_share), "0.8000000000");
      const lines = await entryLines(w.org.orgId, converted.journalEntryId!);
      assert.equal(linesBalance(lines), 0n);
      assert.deepEqual(
        lines.map((line) => line.amount),
        ["100000.0000", "-12.5000", "-99987.5000"],
      );
      await assert.rejects(
        electMfnTerms({ ...manage(w), ...election, idempotencyKey: null }),
        refusal("equity_mfn_closed"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "note interest accrues by idempotent runs on its day count and a conversion consumes the principal and accrued interest",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const issued = await note(w);
      await assert.rejects(
        postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
        (error: unknown) =>
          refusal("equity_account_policy_incomplete")(error) &&
          (error as EquityError).remedy.includes("Setup → Equity accounts"),
      );
      await seedEquityPolicy(w, "2026-07-02", { lifecycle: true });
      await assert.rejects(
        postInterestRun({
          ...approve(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
        refusal("equity_forbidden"),
      );
      const july = applied(
        await postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
      );
      // 100,000 × 8% × 30 / 365 = 657.534… rounded to the cent.
      assert.equal(july.total, "657.5300");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.interestExpense), "657.5300");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.accruedInterest), "-657.5300");
      const replay = applied(
        await postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
      );
      assert.equal(replay.replayed, true);
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.interestExpense),
        "657.5300",
        "a replay accrues nothing more",
      );
      await assert.rejects(
        postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-15",
        }),
        refusal("equity_interest_run_backdated"),
      );
      const preview = await previewInterestRun({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        throughDate: "2026-08-31",
      });
      assert.equal(
        preview.lines[0]!.period,
        "679.4600",
        "61 days accrue 1,336.99; 657.53 is already posted",
      );

      const seriesSeed = await preferredClass(w);
      const round = await createRound({
        ...entity(w),
        name: "Seed",
        shareClassId: seriesSeed,
        closedOn: "2026-08-31",
        pricePerShare: "1.00",
        preMoneyValuation: "5000000",
        preMoneyBasisReason: "Valued on the term sheet before any shares were issued",
      });
      const converted = await recordSecurityEvent({
        ...manage(w),
        securityId: issued.id,
        kind: "convert",
        effectiveOn: "2026-08-31",
        roundId: round.id,
      });
      assert.ok(
        converted.accrualEntryId,
        "the interest since the last run accrues on the conversion date",
      );
      assert.deepEqual(
        (await entryLines(w.org.orgId, converted.accrualEntryId!)).map((line) => line.amount),
        ["679.4600", "-679.4600"],
      );
      const structure = await loadStructure({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-08-31",
      });
      const structureRound = structure.rounds.find((row) => row.id === round.id);
      assert.ok(structureRound);
      assert.deepEqual(
        [structureRound.raised, structureRound.sharesIssued],
        ["0.0000", "0"],
        "conversion certificates are not new cash proceeds or priced-round shares",
      );
      assert.ok(
        structureRound.liveSecurities.some(
          (security) => security.id === converted.resultingSecurityId,
        ),
        "the same conversion certificate remains a dependency of a price amendment or round void",
      );
      const overviewAtConversion = await loadEquityOverview({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-08-31",
        yearStart: "2026-01-01",
      });
      assert.equal(
        overviewAtConversion.latestRound?.raised,
        "0.0000",
        "post-money excludes note conversion proceeds",
      );
      const lines = await entryLines(w.org.orgId, converted.journalEntryId!);
      assert.equal(linesBalance(lines), 0n);
      assert.deepEqual(
        lines.map((line) => [line.account_id, line.amount]),
        [
          [w.accounts.convertible, "100000.0000"],
          [w.accounts.accruedInterest, "1336.9900"],
          [w.accounts.preferred, "-10.1300"],
          [w.accounts.apic, "-101326.8600"],
        ],
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.accruedInterest), "0.0000");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.convertible), "0.0000");
      const certificate = await loadSecurityDetail({
        ...manage(w),
        securityId: converted.resultingSecurityId!,
        asOf: "2026-08-31",
      });
      assert.equal(
        certificate.security.quantity,
        "101336",
        "101,336.99 converts at 1.00 into whole shares",
      );
      await assert.rejects(
        postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-09-30",
        }),
        refusal("equity_run_nothing_due"),
        "a converted note stops accruing, so no run is due",
      );
      await recordSecurityEvent({
        ...manage(w),
        securityId: converted.resultingSecurityId!,
        kind: "void",
        effectiveOn: "2026-10-01",
        reason: "Conversion certificate recorded in error",
      });
      const accrual = (
        await db.execute<{ status: string }>(
          sql`
      select status from journal_entries where org_id = ${w.org.orgId} and id = ${converted.accrualEntryId}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        accrual.status,
        "reversed",
        "voiding a conversion reverses its settlement-date interest accrual",
      );
      const resumed = applied(
        await withSimClock("2026-12-31", () =>
          postInterestRun({
            ...manage(w),
            subsidiaryId: w.org.subsidiaryId,
            throughDate: "2026-10-31",
          }),
        ),
      );
      assert.equal(
        resumed.total,
        "2016.4400",
        "the note resumes accruing without counting the voided settlement accrual",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a note is repaid with its accrued interest, a SAFE repays only its purchase amount, and a reversal undoes a cancellation",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      const issued = await note(w, { considerationAmount: "50000", interestRatePercent: "6" });
      const repayment = {
        securityId: issued.id,
        kind: "repay" as const,
        effectiveOn: "2026-07-31",
        considerationAccountId: w.org.accounts.bank,
      };
      await assert.rejects(
        recordSecurityEvent({ ...approve(w), ...repayment, amount: "50346.58" }),
        refusal("equity_forbidden"),
      );
      // 50,000 × 6% × 30 / 365 = 246.58 accrued; 100.00 above the carrying amount is a repayment premium.
      const repaid = await recordSecurityEvent({ ...manage(w), ...repayment, amount: "50346.58" });
      assert.ok(repaid.accrualEntryId);
      const lines = await entryLines(w.org.orgId, repaid.journalEntryId!);
      assert.equal(linesBalance(lines), 0n);
      assert.equal(await accountBalance(w.org.orgId, w.accounts.convertible), "0.0000");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.accruedInterest), "0.0000");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.interestExpense), "346.5800");
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...repayment, amount: "1" }),
        refusal("equity_convertible_settled"),
      );
      await recordSecurityEvent({
        ...manage(w),
        securityId: issued.id,
        kind: "reverse",
        effectiveOn: "2026-08-01",
        reversesEventId: repaid.eventId,
        reason: "Repayment was recorded in error",
      });
      const settlementAccrual = (
        await db.execute<{ status: string }>(
          sql`
      select status from journal_entries where org_id = ${w.org.orgId} and id = ${repaid.accrualEntryId}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        settlementAccrual.status,
        "reversed",
        "reversing a settlement also reverses its interest accrual entry",
      );
      const historicalRun = applied(
        await postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-15",
        }),
      );
      assert.equal(
        historicalRun.total,
        "115.0700",
        "a later reversed settlement does not block an earlier interest run",
      );
      const repaidAgain = await recordSecurityEvent({
        ...manage(w),
        ...repayment,
        effectiveOn: "2026-08-02",
        amount: "50263.01",
      });
      assert.ok(repaidAgain.accrualEntryId);
      assert.deepEqual(
        (await entryLines(w.org.orgId, repaidAgain.accrualEntryId!)).map((line) => line.amount),
        ["147.9400", "-147.9400"],
        "settlement only tops up interest still accrued after reversals",
      );

      const instrument = await safe(w, { considerationAmount: "25000" });
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: instrument.id,
          kind: "repay",
          effectiveOn: "2026-07-31",
          amount: "24000",
          considerationAccountId: w.org.accounts.bank,
        }),
        refusal("equity_repayment_amount"),
      );
      const cancellation = {
        securityId: instrument.id,
        kind: "cancel" as const,
        effectiveOn: "2026-07-20",
        reason: "Investor released the SAFE",
      };
      await assert.rejects(
        recordSecurityEvent({ ...approve(w), ...cancellation }),
        refusal("equity_forbidden"),
      );
      const cancelled = await recordSecurityEvent({ ...manage(w), ...cancellation });
      assert.deepEqual(
        (await entryLines(w.org.orgId, cancelled.journalEntryId!)).map((line) => [
          line.account_id,
          line.amount,
        ]),
        [
          [w.accounts.convertible, "25000.0000"],
          [w.accounts.apic, "-25000.0000"],
        ],
      );
      const table = await loadCapTableView({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-07-25",
      });
      assert.equal(
        table.table.convertibles.find((row) => row.securityId === instrument.id)?.status,
        "cancelled",
      );
      const reversed = await recordSecurityEvent({
        ...manage(w),
        securityId: instrument.id,
        kind: "reverse",
        effectiveOn: "2026-07-25",
        reversesEventId: cancelled.eventId,
        reason: "Cancellation recorded against the wrong SAFE",
      });
      assert.ok(reversed.reversalEntryId);
      assert.equal(await accountBalance(w.org.orgId, w.accounts.apic), "0.0000");
      const restored = await loadCapTableView({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-07-25",
      });
      assert.equal(
        restored.table.convertibles.find((row) => row.securityId === instrument.id)?.status,
        "outstanding",
      );
      await recordSecurityEvent({
        ...manage(w),
        securityId: instrument.id,
        kind: "repay",
        effectiveOn: "2026-07-31",
        amount: "25000",
        considerationAccountId: w.org.accounts.bank,
      });
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "an early exercise issues restricted stock, holds the deposit, releases it as shares vest and repurchases unvested shares on the grant's terms",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const plan = await createPlan({
        ...entity(w),
        code: "EIP",
        name: "Equity incentive plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "100000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: true,
      });
      const option = await issueSecurity({
        ...entity(w),
        kind: "option",
        holderPartyId: w.holderId,
        issueDate: "2026-05-01",
        shareClassId: w.commonClassId,
        planId: plan.id,
        quantity: "4800",
        pricePerShare: "1.00",
        optionType: "iso",
        expirationDate: "2036-05-01",
        earlyExercise: true,
        unvestedRepurchaseBasis: "lower_of_cost_or_fmv",
        vestingStart: "2026-05-01",
        vestingMonths: 48,
        cliffMonths: 0,
        vestingFrequency: "monthly",
        valuation: {
          sharePrice: "1",
          volatilityPercent: "50",
          riskFreeRatePercent: "4",
          expectedTermYears: "6",
          dividendYieldPercent: "0",
          attribution: "straight_line",
        },
      });
      const exercise = {
        securityId: option.id,
        kind: "exercise" as const,
        effectiveOn: "2026-07-01",
        quantity: "4800",
        considerationAccountId: w.org.accounts.bank,
      };
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...exercise }),
        refusal("equity_account_policy_incomplete"),
        "the deposit account must be mapped",
      );
      await seedEquityPolicy(w, "2026-06-01", { lifecycle: true });
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...exercise, quantity: "4801" }),
        refusal("equity_event_exceeds_vested"),
      );
      const exercised = await recordSecurityEvent({ ...manage(w), ...exercise });
      const fairValue = String(
        (await loadSecurityDetail({ ...manage(w), securityId: option.id, asOf: "2026-07-01" }))
          .security.fair_value_per_unit,
      );
      // Grant-date value of a number of units, rounded half up to the cent, in ledger units (fair value carries ten places).
      const grantValue = (units: bigint) =>
        ((BigInt(fairValue.replace(".", "")) * units + 50_000_000n) / 100_000_000n) * 100n;
      const reclass200 = grantValue(200n);
      const lines = await entryLines(w.org.orgId, exercised.journalEntryId!);
      assert.equal(linesBalance(lines), 0n);
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.deposit),
        "-4600.0000",
        "cash for the 4,600 unvested shares is a deposit",
      );
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.common),
        "-0.0200",
        "only the 200 vested shares reach share capital",
      );
      const certificateId = exercised.resultingSecurityId!;
      const certificate = await loadSecurityDetail({
        ...manage(w),
        securityId: certificateId,
        asOf: "2026-07-01",
      });
      assert.equal(certificate.state?.outstanding, "4800");
      assert.equal(certificate.state?.vestedAvailable, "200");
      assert.equal(certificate.restricted?.restrictedShares, "4600");
      assert.equal(certificate.election83b?.state, "open");
      assert.equal(certificate.election83b?.deadline, "2026-07-31");
      const remaining = await loadSecurityDetail({
        ...manage(w),
        securityId: option.id,
        asOf: "2026-07-01",
      });
      assert.equal(remaining.state?.outstanding, "0");

      await recordSecurityEvent({
        ...manage(w),
        securityId: certificateId,
        kind: "election_83b",
        effectiveOn: "2026-07-20",
      });
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: certificateId,
          kind: "election_83b",
          effectiveOn: "2026-07-21",
        }),
        refusal("equity_83b_recorded"),
      );

      const run = applied(
        await postCompensationRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-09-30",
        }),
      );
      assert.equal(run.releases, 1);
      assert.ok(run.releaseJournalEntryId);
      assert.equal(linesBalance(await entryLines(w.org.orgId, run.releaseJournalEntryId!)), 0n);
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.deposit),
        "-4400.0000",
        "August and September release 200 shares' deposit",
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.common), "-0.0400");
      const released = (
        await db.execute<{ period_reclass: string }>(
          sql`
      select period_reclass::text as period_reclass from equity_compensation_run_releases where org_id = ${w.org.orgId} and run_id = ${run.runId}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        BigInt(released.period_reclass.replace(".", "")),
        reclass200,
        "the released units' grant-date value moves to share capital with them",
      );
      assert.equal(
        applied(
          await postCompensationRun({
            ...manage(w),
            subsidiaryId: w.org.subsidiaryId,
            throughDate: "2026-09-30",
          }),
        ).replayed,
        true,
      );

      const repurchase = {
        securityId: certificateId,
        kind: "repurchase" as const,
        effectiveOn: "2026-10-15",
        quantity: "1000",
        considerationAccountId: w.org.accounts.bank,
        reason: "Holder left before vesting",
      };
      await assert.rejects(
        recordSecurityEvent({ ...approve(w), ...repurchase, fairMarketValuePerShare: "0.50" }),
        refusal("equity_forbidden"),
      );
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...repurchase }),
        (error: unknown) => (error as EquityError).field === "fairMarketValuePerShare",
      );
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...repurchase, quantity: "4400" }),
        refusal("equity_restricted_repurchase_mixed"),
      );
      const bought = await recordSecurityEvent({
        ...manage(w),
        ...repurchase,
        fairMarketValuePerShare: "0.50",
      });
      // The lower of cost (1.00) and fair market value (0.50): 500.00 for 1,000 shares whose deposit was 1,000.00.
      assert.deepEqual(
        (await entryLines(w.org.orgId, bought.journalEntryId!)).map((line) => [
          line.account_id,
          line.amount,
        ]),
        [
          [w.accounts.deposit, "1000.0000"],
          [w.org.accounts.bank, "-500.0000"],
          [w.accounts.apic, "-500.0000"],
        ],
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.deposit), "-3400.0000");
      const overview = await loadEquityOverview({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-10-31",
        yearStart: "2026-01-01",
      });
      const restrictedDeposit = overview.attention.find(
        (item) => item.kind === "restricted_deposit" && item.securityId === certificateId,
      );
      assert.ok(restrictedDeposit && restrictedDeposit.kind === "restricted_deposit");
      assert.equal(
        restrictedDeposit.shares,
        (await loadSecurityDetail({ ...manage(w), securityId: certificateId, asOf: "2026-10-31" }))
          .state?.unvested,
      );
      const optionCost = await loadSecurityDetail({
        ...manage(w),
        securityId: option.id,
        asOf: "2026-10-31",
      });
      assert.equal(
        BigInt(optionCost.compensation!.expectedAfterForfeitures.replace(".", "")),
        grantValue(3800n),
        "the repurchased unvested shares are forfeitures of the option's cost",
      );
      const founderStock = await issueSecurity({
        ...entity(w),
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "1000",
        pricePerShare: "0.0001",
        considerationAccountId: w.org.accounts.bank,
        vestingStart: "2026-07-01",
        vestingMonths: 12,
        cliffMonths: 0,
        vestingFrequency: "monthly",
      });
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: founderStock.id,
          kind: "election_83b",
          effectiveOn: "2026-08-05",
        }),
        refusal("equity_83b_window_closed"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "one forfeiture, cancellation or repurchase is undone by a reversal; dependent activity refuses by name",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const plan = await createPlan({
        ...entity(w),
        code: "EIP",
        name: "Equity incentive plan",
        shareClassId: w.commonClassId,
        effectiveOn: "2026-01-01",
        reservedShares: "1000",
        recycleForfeited: true,
        recycleExpired: true,
        recycleRepurchased: false,
      });
      const award = (quantity: string, issueDate = "2026-07-01") =>
        issueSecurity({
          ...entity(w),
          kind: "rsu",
          holderPartyId: w.holderId,
          issueDate,
          shareClassId: w.commonClassId,
          planId: plan.id,
          quantity,
          vestingStart: "2026-07-01",
          vestingMonths: 10,
          cliffMonths: 0,
          vestingFrequency: "monthly",
          valuation: { sharePrice: "1", attribution: "straight_line" },
        });
      const rsu = await award("1000");
      const forfeit = await recordSecurityEvent({
        ...manage(w),
        securityId: rsu.id,
        kind: "forfeit",
        effectiveOn: "2026-07-10",
        quantity: "500",
        reason: "Recorded against the wrong award",
      });
      const reversal = {
        securityId: rsu.id,
        kind: "reverse" as const,
        effectiveOn: "2026-07-12",
        reversesEventId: forfeit.eventId,
        reason: "The forfeiture was recorded in error",
      };
      await assert.rejects(
        recordSecurityEvent({ ...approve(w), ...reversal }),
        refusal("equity_forbidden"),
      );
      await recordSecurityEvent({ ...manage(w), ...reversal });
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: rsu.id, asOf: "2026-07-11" })).state
          ?.outstanding,
        "500",
        "history before the reversal stands",
      );
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: rsu.id, asOf: "2026-07-12" })).state
          ?.outstanding,
        "1000",
      );
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...reversal }),
        refusal("equity_event_reversed"),
      );

      const second = await recordSecurityEvent({
        ...manage(w),
        securityId: rsu.id,
        kind: "forfeit",
        effectiveOn: "2026-07-15",
        quantity: "200",
        reason: "Partial forfeiture",
      });
      const cancel = await recordSecurityEvent({
        ...manage(w),
        securityId: rsu.id,
        kind: "cancel",
        effectiveOn: "2026-07-20",
        quantity: "100",
        reason: "Partial cancellation",
      });
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: rsu.id,
          kind: "reverse",
          effectiveOn: "2026-07-21",
          reversesEventId: second.eventId,
          reason: "Forfeiture in error",
        }),
        (error: unknown) =>
          refusal("equity_reversal_has_dependents")(error) &&
          (error as EquityError).remedy.includes("cancellation of Jul 20, 2026"),
      );
      await recordSecurityEvent({
        ...manage(w),
        securityId: rsu.id,
        kind: "reverse",
        effectiveOn: "2026-07-21",
        reversesEventId: cancel.eventId,
        reason: "Cancellation in error",
      });
      await recordSecurityEvent({
        ...manage(w),
        securityId: rsu.id,
        kind: "reverse",
        effectiveOn: "2026-07-22",
        reversesEventId: second.eventId,
        reason: "Forfeiture in error",
      });
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: rsu.id, asOf: "2026-07-22" })).state
          ?.outstanding,
        "1000",
      );

      // A forfeiture returns units to the pool; once they are granted again, undoing it would overdraw the pool.
      const forfeitAll = await recordSecurityEvent({
        ...manage(w),
        securityId: rsu.id,
        kind: "forfeit",
        effectiveOn: "2026-07-25",
        quantity: "900",
        reason: "Holder left",
      });
      await award("900", "2026-07-26");
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: rsu.id,
          kind: "reverse",
          effectiveOn: "2026-07-27",
          reversesEventId: forfeitAll.eventId,
          reason: "Holder stayed",
        }),
        refusal("equity_pool_exhausted"),
      );

      const shares = await issueSecurity({
        ...entity(w),
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "1000",
        pricePerShare: "1",
        considerationAccountId: w.org.accounts.bank,
      });
      const buyback = await recordSecurityEvent({
        ...manage(w),
        securityId: shares.id,
        kind: "repurchase",
        effectiveOn: "2026-07-10",
        quantity: "400",
        amount: "400",
        considerationAccountId: w.org.accounts.bank,
        reason: "Buyback",
      });
      assert.equal(await accountBalance(w.org.orgId, w.accounts.treasury), "400.0000");
      const undone = await recordSecurityEvent({
        ...manage(w),
        securityId: shares.id,
        kind: "reverse",
        effectiveOn: "2026-07-11",
        reversesEventId: buyback.eventId,
        reason: "Buyback was not completed",
      });
      const original = (
        await db.execute<{ status: string }>(
          sql`select status from journal_entries where org_id = ${w.org.orgId} and id = ${buyback.journalEntryId}`,
          "objects",
        )
      )[0]!;
      assert.equal(original.status, "reversed");
      assert.ok(undone.reversalEntryId);
      assert.equal(await accountBalance(w.org.orgId, w.accounts.treasury), "0.0000");
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: shares.id, asOf: "2026-07-11" }))
          .state?.outstanding,
        "1000",
      );
      const warrant = await issueSecurity({
        ...entity(w),
        kind: "warrant",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "100",
        pricePerShare: "1",
      });
      const exercised = await recordSecurityEvent({
        ...manage(w),
        securityId: warrant.id,
        kind: "exercise",
        effectiveOn: "2026-07-05",
        quantity: "10",
        considerationAccountId: w.org.accounts.bank,
      });
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: warrant.id,
          kind: "reverse",
          effectiveOn: "2026-07-06",
          reversesEventId: exercised.eventId,
          reason: "Exercise in error",
        }),
        refusal("equity_event_not_reversible"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a common split adjusts the conversion price of preferred converting into it; a preferred class without a conversion class refuses the split",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await assert.rejects(
        createShareClass({
          ...entity(w),
          code: "SX",
          name: "Series X",
          kind: "preferred",
          effectiveOn: "2026-01-01",
          authorizedShares: "1000",
          parValue: "0.0001",
          originalIssuePrice: "1",
        }),
        refusal("equity_class_terms_invalid"),
      );
      const seriesA = await preferredClass(w);
      const issue = (shareClassId: string) =>
        issueSecurity({
          ...entity(w),
          kind: "share",
          holderPartyId: w.holderId,
          issueDate: "2026-07-01",
          shareClassId,
          quantity: "1000",
          pricePerShare: "1",
          considerationAccountId: w.org.accounts.bank,
        });
      await issue(w.commonClassId);
      const preferredShares = await issue(seriesA);
      const split = await recordSplit({
        ...manage(w),
        shareClassId: w.commonClassId,
        effectiveOn: "2026-07-15",
        ratioNumerator: "2",
        ratioDenominator: "1",
        reason: "Two-for-one forward split",
      });
      assert.deepEqual(
        split.adjustedClasses.map((row) => [
          row.code,
          row.conversionPriceBefore,
          row.conversionPriceAfter,
        ]),
        [["SA", "1.0000000000", "0.5000000000"]],
      );
      const table = await loadCapTableView({
        ...manage(w),
        subsidiaryId: w.org.subsidiaryId,
        asOf: "2026-07-15",
      });
      assert.equal(
        table.table.classes.find((row) => row.shareClassId === seriesA)?.asConvertedOutstanding,
        "2000",
      );
      assert.equal(table.table.totals.asConvertedOutstanding, "4000");

      const legacy = randomUUID();
      await db.execute(sql`
      insert into equity_share_classes (id, org_id, subsidiary_id, code, name, kind, effective_on, initial_authorized_shares, par_value,
        original_issue_price, initial_conversion_price, liquidation_multiple, created_by)
      values (${legacy}, ${w.org.orgId}, ${w.org.subsidiaryId}, 'SB', 'Series B', 'preferred', '2026-01-01', 1000, 0.0001, 1, 1, 1, ${w.managerId})`);
      const nextSplit = {
        ...manage(w),
        shareClassId: w.commonClassId,
        effectiveOn: "2026-07-25",
        ratioNumerator: "3",
        ratioDenominator: "2",
        reason: "Three-for-two forward split",
      };
      await assert.rejects(
        recordSplit(nextSplit),
        (error: unknown) =>
          refusal("equity_conversion_class_missing")(error) &&
          (error as EquityError).message.includes("SB"),
      );
      await assert.rejects(
        amendShareClass({
          ...approve(w),
          shareClassId: legacy,
          kind: "conversion_class",
          effectiveOn: "2026-07-20",
          conversionShareClassId: w.commonClassId,
          reason: "Converts into common",
        }),
        refusal("equity_forbidden"),
      );
      await amendShareClass({
        ...manage(w),
        shareClassId: legacy,
        kind: "conversion_class",
        effectiveOn: "2026-07-20",
        conversionShareClassId: w.commonClassId,
        reason: "Converts into common",
      });
      const adjusted = await recordSplit(nextSplit);
      assert.deepEqual(adjusted.adjustedClasses.map((row) => row.code).sort(), ["SA", "SB"]);

      const otherCommon = await createShareClass({
        ...entity(w),
        code: "CB",
        name: "Common B",
        kind: "common",
        effectiveOn: "2026-01-01",
        authorizedShares: "100000",
        parValue: "0.0001",
      });
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: preferredShares.id,
          kind: "convert",
          effectiveOn: "2026-07-30",
          quantity: "10",
          targetShareClassId: otherCommon.id,
        }),
        (error: unknown) => (error as EquityError).field === "targetShareClassId",
      );
      const converted = await recordSecurityEvent({
        ...manage(w),
        securityId: preferredShares.id,
        kind: "convert",
        effectiveOn: "2026-07-30",
        quantity: "10",
      });
      const certificate = await loadSecurityDetail({
        ...manage(w),
        securityId: converted.resultingSecurityId!,
        asOf: "2026-07-30",
      });
      assert.equal(
        certificate.security.quantity,
        "30",
        "after 2:1 and 3:2 splits one preferred share converts into three common",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a SAFE stated in a foreign currency posts at its issue-date rate, refuses without one, and repays with a realized exchange difference",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-07-01", "1.3500000000");
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-07-20", "1.4000000000");
      await db.execute(
        sql`insert into currencies (code, name, minor_units) values ('GBP', 'Pound Sterling', 2) on conflict (code) do nothing`,
      );
      await assert.rejects(
        safe(w, { currency: "GBP", considerationAmount: "1000" }),
        refusal("equity_fx_rate_missing"),
      );
      const issued = await safe(w, { currency: "USD", considerationAmount: "10000" });
      const issuance = await entryLines(w.org.orgId, issued.journalEntryId!);
      assert.deepEqual(
        issuance.map((line) => [line.amount, line.currency, line.txn_amount]),
        [
          ["13500.0000", "USD", "10000.0000"],
          ["-13500.0000", "USD", "-10000.0000"],
        ],
      );
      const repayment = {
        securityId: issued.id,
        kind: "repay" as const,
        effectiveOn: "2026-07-20",
        amount: "10000",
        considerationAccountId: w.org.accounts.bank,
      };
      await db.execute(
        sql`update orgs set settings = settings #- '{controlAccounts,fxRealizedGainLoss}' where id = ${w.org.orgId}`,
      );
      await assert.rejects(
        recordSecurityEvent({ ...manage(w), ...repayment }),
        refusal("equity_fx_account_missing"),
      );
      await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{controlAccounts,fxRealizedGainLoss}', to_jsonb(${w.org.accounts.fxGainLoss}::text), true)
       where id = ${w.org.orgId}`);
      const repaid = await recordSecurityEvent({ ...manage(w), ...repayment });
      const lines = await entryLines(w.org.orgId, repaid.journalEntryId!);
      assert.equal(linesBalance(lines), 0n);
      assert.equal(await accountBalance(w.org.orgId, w.accounts.convertible), "0.0000");
      assert.equal(
        await accountBalance(w.org.orgId, w.org.accounts.fxGainLoss),
        "500.0000",
        "10,000 USD carried at 1.35 and repaid at 1.40",
      );
      await assert.rejects(
        createRound({
          ...entity(w),
          name: "Euro round",
          shareClassId: w.commonClassId,
          closedOn: "2026-07-20",
          pricePerShare: "1",
          preMoneyValuation: "1000000",
          currency: "EUR",
        }),
        (error: unknown) =>
          refusal("equity_fx_rate_missing")(error) || refusal("equity_currency_unknown")(error),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a voided note's accrued interest reverses in the next run, and a foreign note accrues at the run date's rate",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-07-01", "1.3500000000");
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-07-31", "1.3600000000");
      const local = await note(w);
      await note(w, { currency: "USD", considerationAmount: "10000", interestRatePercent: "6" });
      const july = applied(
        await postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-07-31",
        }),
      );
      // 657.53 CAD, and 49.32 USD (10,000 × 6% × 30 / 365) at 1.36.
      assert.equal(july.total, "724.6052");
      const lines = await entryLines(w.org.orgId, july.journalEntryId!);
      assert.ok(
        lines.some(
          (line) =>
            line.currency === "USD" && line.txn_amount === "-49.3200" && line.amount === "-67.0752",
        ),
        "the foreign accrual carries its USD amount and rate",
      );
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-08-31", "1.3700000000");
      await recordSecurityEvent({
        ...manage(w),
        securityId: local.id,
        kind: "void",
        effectiveOn: "2026-08-05",
        reason: "Note recorded in error",
      });
      const august = applied(
        await postInterestRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-08-31",
        }),
      );
      const reversed = (
        await db.execute<{
          period_amount: string;
          fx_rate: string | null;
          functional_amount: string;
        }>(
          sql`
      select period_amount::text as period_amount, fx_rate::text as fx_rate, functional_amount::text as functional_amount
        from equity_interest_run_lines where org_id = ${w.org.orgId} and run_id = ${august.runId} and security_id = ${local.id}`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(
        reversed,
        { period_amount: "-657.5300", fx_rate: null, functional_amount: "-657.5300" },
        "the voided note's accrual reverses exactly",
      );
      // 100.27 USD accrued to August 31 less 49.32 already posted, at 1.37.
      assert.equal(await accountBalance(w.org.orgId, w.accounts.interestExpense), "136.8767");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.accruedInterest), "-136.8767");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "voiding an early-exercise certificate returns its units and the next run reverses the deposit it released",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      const option = await issueSecurity({
        ...entity(w),
        kind: "option",
        holderPartyId: w.holderId,
        issueDate: "2026-06-01",
        shareClassId: w.commonClassId,
        quantity: "1200",
        pricePerShare: "1.00",
        optionType: "nso",
        expirationDate: "2036-06-01",
        earlyExercise: true,
        unvestedRepurchaseBasis: "cost",
        vestingStart: "2026-06-01",
        vestingMonths: 12,
        cliffMonths: 0,
        vestingFrequency: "monthly",
        valuation: {
          sharePrice: "1",
          volatilityPercent: "50",
          riskFreeRatePercent: "4",
          expectedTermYears: "6",
          dividendYieldPercent: "0",
          attribution: "graded",
        },
      });
      const exercised = await recordSecurityEvent({
        ...manage(w),
        securityId: option.id,
        kind: "exercise",
        effectiveOn: "2026-07-01",
        quantity: "1200",
        considerationAccountId: w.org.accounts.bank,
      });
      assert.equal(await accountBalance(w.org.orgId, w.accounts.deposit), "-1100.0000");
      applied(
        await postCompensationRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-08-31",
        }),
      );
      assert.equal(
        await accountBalance(w.org.orgId, w.accounts.deposit),
        "-1000.0000",
        "August releases 100 shares' deposit",
      );
      await recordSecurityEvent({
        ...manage(w),
        securityId: exercised.resultingSecurityId!,
        kind: "void",
        effectiveOn: "2026-09-05",
        reason: "Exercise recorded against the wrong grant",
      });
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: option.id, asOf: "2026-09-05" }))
          .state?.outstanding,
        "1200",
        "the voided certificate returns its units to the option",
      );
      const run = applied(
        await postCompensationRun({
          ...manage(w),
          subsidiaryId: w.org.subsidiaryId,
          throughDate: "2026-09-30",
        }),
      );
      assert.ok(run.releaseJournalEntryId);
      assert.equal(await accountBalance(w.org.orgId, w.accounts.deposit), "0.0000");
      assert.equal(await accountBalance(w.org.orgId, w.accounts.common), "0.0000");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a foreign-currency SAFE converts at the closing-date rate and its liability is remeasured with a realized difference",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-07-01", "1.3500000000");
      await seedSpotRate(w.org.orgId, "USD", "CAD", "2026-07-20", "1.4000000000");
      const instrument = await safe(w, { currency: "USD", considerationAmount: "10000" });
      const round = await createRound({
        ...entity(w),
        name: "Seed",
        shareClassId: w.commonClassId,
        closedOn: "2026-07-20",
        pricePerShare: "1.00",
        preMoneyValuation: "1000000",
        preMoneyBasisReason: "Valued on the term sheet before any shares were issued",
      });
      const converted = await recordSecurityEvent({
        ...manage(w),
        securityId: instrument.id,
        kind: "convert",
        effectiveOn: "2026-07-20",
        roundId: round.id,
      });
      const certificate = await loadSecurityDetail({
        ...manage(w),
        securityId: converted.resultingSecurityId!,
        asOf: "2026-07-20",
      });
      assert.equal(
        certificate.security.quantity,
        "14000",
        "10,000 USD at 1.40 converts at 1.00 CAD a share",
      );
      assert.equal(certificate.security.currency, "CAD");
      const lines = await entryLines(w.org.orgId, converted.journalEntryId!);
      assert.equal(linesBalance(lines), 0n);
      assert.deepEqual(
        lines.map((line) => [line.account_id, line.amount, line.currency]),
        [
          [w.accounts.convertible, "13500.0000", "USD"],
          [w.org.accounts.fxGainLoss, "500.0000", "CAD"],
          [w.accounts.common, "-1.4000", "CAD"],
          [w.accounts.apic, "-13998.6000", "CAD"],
        ],
      );
      assert.equal(await accountBalance(w.org.orgId, w.accounts.convertible), "0.0000");
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
