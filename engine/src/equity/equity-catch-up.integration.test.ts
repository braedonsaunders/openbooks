import assert from "node:assert/strict";
import test from "node:test";
import { renderRefusal } from "../platform/catalog-refusal.ts";
import { EQUITY_REFUSALS } from "./refusals/index.ts";
import { installEngineSeams } from "../composition/install.ts";
import { withSimClock } from "../platform/clock.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  applied,
  equityRefusal as refusal,
  setupEquityWorld,
  type EquityWorld,
} from "../testing/equity-world.ts";
import { postCompensationRun, previewCompensationRun } from "./compensation-run.ts";
import { EquityError } from "./errors.ts";
import { recordSecurityEvent } from "./events.ts";
import { postInterestRun } from "./interest-run.ts";
import { loadEquityOverview } from "./overview.ts";
import { closeEquityPostings, equityRunCatchUp, nextEquityRunPeriod } from "./period-postings.ts";
import { loadSecurityDetail, loadStructure } from "./read-model.ts";
import { amendRound } from "./rounds.ts";
import { issueSecurity } from "./securities.ts";
import { createRound, createShareClass } from "./structure.ts";

installEngineSeams();

const DB = !!process.env.OPENBOOKS_DB_URL;

const manage = (w: EquityWorld) => ({ orgId: w.org.orgId, actorId: w.managerId });
const entity = (w: EquityWorld) => ({ ...manage(w), subsidiaryId: w.org.subsidiaryId });

const rsu = (w: EquityWorld, issueDate: string, quantity: string) =>
  issueSecurity({
    ...entity(w),
    kind: "rsu",
    holderPartyId: w.holderId,
    issueDate,
    shareClassId: w.commonClassId,
    quantity,
    vestingStart: issueDate,
    vestingMonths: 12,
    cliffMonths: 0,
    vestingFrequency: "monthly",
    valuation: { sharePrice: "1.00", attribution: "straight_line" },
  });

const note = (w: EquityWorld, issueDate: string) =>
  issueSecurity({
    ...entity(w),
    kind: "note",
    holderPartyId: w.holderId,
    issueDate,
    considerationAmount: "100000",
    considerationAccountId: w.org.accounts.bank,
    interestRatePercent: "8",
    interestBasis: "simple",
    interestDayCount: "actual_365",
  });

test(
  "cost and interest recorded after a posted run for the periods it measured are due as a catch-up and post with the next run",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      await rsu(w, "2026-07-01", "1200");
      await note(w, "2026-07-01");
      await withSimClock("2026-09-02T12:00:00Z", async () => {
        applied(await postCompensationRun({ ...entity(w), throughDate: "2026-08-31" }));
        applied(await postInterestRun({ ...entity(w), throughDate: "2026-08-31" }));
      });
      // A grant and a note dated before the August runs, recorded after them.
      const late = await rsu(w, "2026-07-15", "2400");
      await note(w, "2026-08-10");

      let caughtUp = "";
      await withSimClock("2026-09-10T12:00:00Z", async () => {
        const overview = await loadEquityOverview({
          ...entity(w),
          asOf: "2026-09-10",
          yearStart: "2026-01-01",
        });
        assert.equal(overview.postings?.throughDate, "2026-08-31");
        assert.equal(
          overview.postings?.compensation.due,
          false,
          "the run through August stands as posted",
        );
        const catchUp = overview.postings!.compensation.catchUp!;
        assert.ok(/[1-9]/.test(catchUp.amount), "the late grant's cost through August is due");
        assert.deepEqual(
          [catchUp.recognizedThrough, catchUp.postsWith?.endsOn, catchUp.postsWith?.ended],
          ["2026-08-31", "2026-09-30", false],
        );
        caughtUp = catchUp.amount;
        const item = overview.attention.find((row) => row.kind === "compensation_catch_up");
        assert.ok(
          item &&
            item.kind === "compensation_catch_up" &&
            item.amount === catchUp.amount &&
            item.postsThrough === "2026-09-30" &&
            !item.postsNow,
        );
        const interest = overview.attention.find((row) => row.kind === "interest_catch_up");
        assert.ok(
          interest && interest.kind === "interest_catch_up" && /[1-9]/.test(interest.amount),
          "the late note's interest through August is due",
        );
        assert.deepEqual(await equityRunCatchUp({ ...entity(w), kind: "compensation" }), catchUp);

        assert.equal(
          await nextEquityRunPeriod({ ...entity(w), kind: "compensation", today: "2026-09-10" }),
          null,
          "September has not ended",
        );
        await assert.rejects(
          postCompensationRun({ ...entity(w), throughDate: "2026-09-30" }),
          refusal("equity_run_period_not_ended"),
        );
        await assert.rejects(
          postInterestRun({ ...entity(w), throughDate: "2026-09-30" }),
          refusal("equity_run_period_not_ended"),
        );
        const august = await closeEquityPostings(w.org.orgId, {
          through: "2026-08-31",
          subsidiaryIds: [],
        });
        assert.deepEqual(
          [august.compensation, august.interest],
          [[], []],
          "the close of August is not held back by what posts in September",
        );
      });

      await withSimClock("2026-10-01T12:00:00Z", async () => {
        assert.equal(
          (await nextEquityRunPeriod({ ...entity(w), kind: "compensation", today: "2026-10-01" }))
            ?.endsOn,
          "2026-09-30",
        );
        const preview = await previewCompensationRun({ ...entity(w), throughDate: "2026-09-30" });
        const line = preview.lines.find((row) => row.securityId === late.id)!;
        assert.deepEqual(
          [line.previous, line.catchUp, preview.catchUpTotal, preview.blocked],
          ["0.0000", caughtUp, caughtUp, null],
          "the run names what it catches up",
        );
        const run = applied(await postCompensationRun({ ...entity(w), throughDate: "2026-09-30" }));
        assert.equal(run.total, preview.total);
        applied(await postInterestRun({ ...entity(w), throughDate: "2026-09-30" }));
        assert.equal(await equityRunCatchUp({ ...entity(w), kind: "compensation" }), null);
        assert.equal(await equityRunCatchUp({ ...entity(w), kind: "interest" }), null);
        const overview = await loadEquityOverview({
          ...entity(w),
          asOf: "2026-10-01",
          yearStart: "2026-01-01",
        });
        assert.ok(
          !overview.attention.some(
            (row) => row.kind === "compensation_catch_up" || row.kind === "interest_catch_up",
          ),
        );
      });
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a round's pre-money drifts when shares dated before it are recorded later, and the governed amendment proposes only what the round can take",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      const common = (shares: string, issueDate: string) =>
        issueSecurity({
          ...entity(w),
          kind: "share",
          holderPartyId: w.holderId,
          issueDate,
          shareClassId: w.commonClassId,
          quantity: shares,
          pricePerShare: "0.0001",
          considerationAccountId: w.org.accounts.bank,
        });
      await common("2000000", "2026-07-01");
      const seriesA = (
        await createShareClass({
          ...entity(w),
          code: "A3",
          name: "Series A-3",
          kind: "preferred",
          effectiveOn: "2026-01-01",
          authorizedShares: "5000000",
          parValue: "0.0001",
          originalIssuePrice: "3.50",
          conversionShareClassId: w.commonClassId,
        })
      ).id;
      const round = await createRound({
        ...entity(w),
        name: "Series A-3",
        shareClassId: seriesA,
        closedOn: "2026-08-15",
        pricePerShare: "3.50",
        preMoneyValuation: "7000000",
      });
      await issueSecurity({
        ...entity(w),
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-08-15",
        shareClassId: seriesA,
        roundId: round.id,
        quantity: "100000",
        considerationAccountId: w.org.accounts.bank,
      });
      const structure = () => loadStructure({ ...entity(w), asOf: "2026-08-31" });
      assert.equal(
        (await structure()).rounds[0]!.preMoneyDrift,
        null,
        "the valuation agrees as recorded",
      );

      await common("1000", "2026-07-20");
      assert.deepEqual((await structure()).rounds[0]!.preMoneyDrift, {
        fullyDilutedBefore: "2001000",
        impliedPreMoney: "7003500.0000",
      });
      const overview = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-08-31",
        yearStart: "2026-01-01",
      });
      const item = overview.attention.find((row) => row.kind === "round_pre_money_drift");
      assert.ok(
        item &&
          item.kind === "round_pre_money_drift" &&
          item.roundId === round.id &&
          item.impliedPreMoney === "7003500.0000" &&
          item.preMoneyValuation === "7000000.0000",
      );

      await assert.rejects(
        amendRound({
          ...manage(w),
          roundId: round.id,
          effectiveOn: "2026-08-31",
          preMoneyValuation: "8000000",
          reason: "Valuation per the board minutes",
        }),
        (error: unknown) => {
          if (
            !(error instanceof EquityError) ||
            error.code !== "equity_round_pre_money_inconsistent"
          )
            return false;
          assert.doesNotMatch(
            error.remedy,
            /price per share of/,
            "the price is held by the shares issued at it",
          );
          assert.match(
            error.remedy,
            /pre-money valuation of CA\$7,003,500\.00 \(the price stays at CA\$3\.5000, since live securities were issued or converted at it\)/,
            "the price reads under the four-place per-share rule",
          );
          assert.match(
            error.remedy,
            /under “Pre-money basis”\.$/,
            "the remedy names the field by its form label",
          );
          return true;
        },
      );
      applied(
        await amendRound({
          ...manage(w),
          roundId: round.id,
          effectiveOn: "2026-08-31",
          preMoneyValuation: "7003500",
          reason: "Restated for shares issued before the round",
        }),
      );
      assert.equal((await structure()).rounds[0]!.preMoneyDrift, null);
      assert.ok(
        !(
          await loadEquityOverview({ ...entity(w), asOf: "2026-08-31", yearStart: "2026-01-01" })
        ).attention.some((row) => row.kind === "round_pre_money_drift"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "an exercise with nothing vested names the next vest date, vesting starts at issue by default, and a 0% discount is a recorded term",
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
      const option = await issueSecurity({
        ...entity(w),
        kind: "option",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "48000",
        pricePerShare: "0.10",
        optionType: "nso",
        expirationDate: "2036-07-01",
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "monthly",
        valuation: {
          sharePrice: "0.10",
          volatilityPercent: "55",
          riskFreeRatePercent: "4.00",
          expectedTermYears: "6",
          dividendYieldPercent: "0",
          attribution: "straight_line",
        },
      });
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: option.id, asOf: "2026-07-01" }))
          .security.vesting_start,
        "2026-07-01",
        "the schedule starts on the issue date",
      );
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: option.id,
          kind: "exercise",
          effectiveOn: "2026-08-01",
          quantity: "100",
          considerationAccountId: w.org.accounts.bank,
        }),
        (error: unknown) =>
          error instanceof EquityError &&
          error.code === "equity_event_nothing_vested" &&
          error.field === "effectiveOn" &&
          /is vested yet on Aug 1, 2026; the first units vest on Jul 1, 2027/.test(error.message) &&
          error.remedy ===
            "Set “Effective date” on or after Jul 1, 2027, when the first units vest." &&
          renderRefusal(EQUITY_REFUSALS[error.key].remedy, error.values, "de-DE").includes(
            "1. Juli 2027",
          ),
      );

      const safe = await issueSecurity({
        ...entity(w),
        kind: "safe",
        holderPartyId: w.holderId,
        issueDate: "2026-07-02",
        considerationAmount: "25000",
        considerationAccountId: w.org.accounts.bank,
        safeType: "post_money",
        valuationCap: "5000000",
        discountPercent: "0",
      });
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: safe.id, asOf: "2026-07-02" }))
          .convertible!.discountPercent,
        "0.0000",
        "a stated 0% discount is kept apart from no discount",
      );
      await assert.rejects(
        issueSecurity({
          ...entity(w),
          kind: "safe",
          holderPartyId: w.holderId,
          issueDate: "2026-07-02",
          considerationAmount: "25000",
          considerationAccountId: w.org.accounts.bank,
          safeType: "post_money",
          discountPercent: "100",
        }),
        (error: unknown) => error instanceof EquityError && error.field === "discountPercent",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
