import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { withSimClock } from "../platform/clock.ts";
import { db } from "../platform/db.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import {
  applied,
  equityRefusal as refusal,
  seedHolder,
  setEquityFeature,
  setupEquityWorld,
  type EquityWorld,
} from "../testing/equity-world.ts";
import { postCompensationRun } from "./compensation-run.ts";
import { postInterestRun } from "./interest-run.ts";
import { loadEquityOverview } from "./overview.ts";
import { closeEquityPostings, equityPostingsDue } from "./period-postings.ts";
import { issueSecurity } from "./securities.ts";
import { createPlan, createRound, createShareClass } from "./structure.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

const manage = (w: EquityWorld) => ({ orgId: w.org.orgId, actorId: w.managerId });
const entity = (w: EquityWorld) => ({ ...manage(w), subsidiaryId: w.org.subsidiaryId });

/** A cap table with founder stock, a priced round, a SAFE, a note and a plan award that vests after a one-year cliff. */
async function seedBook(w: EquityWorld) {
  const founder = await issueSecurity({
    ...entity(w),
    kind: "share",
    holderPartyId: w.holderId,
    issueDate: "2026-07-10",
    shareClassId: w.commonClassId,
    quantity: "4000000",
    pricePerShare: "0.0001",
    considerationAccountId: w.org.accounts.bank,
    vestingStart: "2026-07-10",
    vestingMonths: 48,
    cliffMonths: 12,
    vestingFrequency: "monthly",
    acceleration: "none",
  });
  const seed = (
    await createShareClass({
      ...entity(w),
      code: "SEED",
      name: "Series Seed",
      kind: "preferred",
      effectiveOn: "2026-01-01",
      authorizedShares: "2000000",
      parValue: "0.0001",
      originalIssuePrice: "1.0000",
      conversionShareClassId: w.commonClassId,
      seniority: 1,
    })
  ).id;
  const round = await createRound({
    ...entity(w),
    name: "Series Seed",
    shareClassId: seed,
    closedOn: "2026-07-12",
    pricePerShare: "1.0000",
    preMoneyValuation: "4000000",
  });
  const investor = await seedHolder(w.org.orgId, "Seed Investor");
  await issueSecurity({
    ...entity(w),
    kind: "share",
    holderPartyId: investor,
    issueDate: "2026-07-12",
    shareClassId: seed,
    roundId: round.id,
    quantity: "1000000",
    pricePerShare: "1.0000",
    considerationAmount: "1000000",
    considerationAccountId: w.org.accounts.bank,
  });
  await issueSecurity({
    ...entity(w),
    kind: "safe",
    holderPartyId: investor,
    issueDate: "2026-07-13",
    considerationAmount: "100000",
    considerationAccountId: w.org.accounts.bank,
    safeType: "post_money",
    valuationCap: "8000000",
  });
  await issueSecurity({
    ...entity(w),
    kind: "note",
    holderPartyId: investor,
    issueDate: "2026-07-13",
    considerationAmount: "50000",
    considerationAccountId: w.org.accounts.bank,
    interestRatePercent: "6",
    interestBasis: "simple",
    interestDayCount: "actual_365",
  });
  const plan = await createPlan({
    ...entity(w),
    code: "EIP",
    name: "Equity Incentive Plan",
    shareClassId: w.commonClassId,
    effectiveOn: "2026-01-01",
    reservedShares: "1000000",
    recycleForfeited: true,
    recycleExpired: true,
    recycleRepurchased: false,
  });
  const employee = await seedHolder(w.org.orgId, "Employee One");
  const option = await issueSecurity({
    ...entity(w),
    kind: "option",
    holderPartyId: employee,
    issueDate: "2026-01-02",
    shareClassId: w.commonClassId,
    planId: plan.id,
    quantity: "48000",
    pricePerShare: "0.5000",
    optionType: "iso",
    expirationDate: "2036-01-02",
    vestingStart: "2026-01-02",
    vestingMonths: 48,
    cliffMonths: 12,
    vestingFrequency: "monthly",
    acceleration: "none",
    valuation: {
      sharePrice: "0.5",
      volatilityPercent: "50",
      riskFreeRatePercent: "4",
      expectedTermYears: "6",
      dividendYieldPercent: "0",
      attribution: "straight_line",
    },
  });
  return { founder, option, employee, investor };
}

test(
  "the overview reads the capitalization, ownership, latest round, money raised and due work from one snapshot",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      const book = await seedBook(w);
      const july = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-07-20",
        yearStart: "2026-01-01",
      });
      // 4,000,000 founder + 1,000,000 preferred as converted, 48,000 options, 952,000 unallocated pool.
      assert.equal(july.totals.fullyDiluted, "6000000");
      assert.equal(july.totals.poolAvailable, "952000");
      const slices = july.ownership.map((slice) => [slice.group, slice.code, slice.shares]);
      assert.deepEqual(slices, [
        ["class", "CS", "4000000"],
        ["class", "SEED", "1000000"],
        ["option", null, "48000"],
        ["pool", null, "952000"],
      ]);
      assert.equal(
        july.ownership.reduce((sum, slice) => sum + BigInt(slice.shares), 0n),
        BigInt(july.totals.fullyDiluted),
        "the slices sum to fully diluted",
      );
      assert.equal(july.latestRound?.name, "Series Seed");
      assert.equal(
        july.latestRound?.postMoneyValuation,
        "5000000.0000",
        "post-money is the pre-money plus the round's new money",
      );
      assert.deepEqual(july.raised, [
        {
          currency: july.entity.currency,
          priced: "1000000.0000",
          convertible: "150000.0000",
          total: "1150000.0000",
        },
      ]);
      assert.equal(july.convertiblesOutstanding, 2);
      const election = july.attention.find((item) => item.kind === "election_83b");
      assert.ok(
        election &&
          election.kind === "election_83b" &&
          election.securityId === book.founder.id &&
          election.date === "2026-08-09",
        "the founder's 83(b) deadline is listed",
      );
      assert.ok(
        !july.attention.some((item) => item.kind === "cliff"),
        "no cliff falls within thirty days of July",
      );

      const december = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-12-15",
        yearStart: "2026-01-01",
      });
      const cliff = december.attention.find((item) => item.kind === "cliff");
      assert.ok(
        cliff &&
          cliff.kind === "cliff" &&
          cliff.securityId === book.option.id &&
          cliff.date === "2027-01-02" &&
          cliff.quantity === "12000",
      );
      assert.ok(
        !december.attention.some((item) => item.kind === "election_83b"),
        "an expired election window is no longer an upcoming deadline",
      );
      assert.equal(
        december.postings?.throughDate,
        "2026-11-30",
        "runs are measured through the latest period end on or before the date",
      );
      assert.ok(
        december.attention.some(
          (item) => item.kind === "compensation_due" && item.date === "2026-11-30",
        ),
      );
      assert.ok(
        december.attention.some(
          (item) => item.kind === "interest_due" && item.date === "2026-11-30",
        ),
      );
      assert.equal(december.compensationPosted.amount, "0.0000");

      const run = await withSimClock("2026-12-01T12:00:00Z", async () => {
        const posted = applied(
          await postCompensationRun({ ...entity(w), throughDate: "2026-11-30" }),
        );
        applied(await postInterestRun({ ...entity(w), throughDate: "2026-11-30" }));
        return posted;
      });
      const posted = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-12-15",
        yearStart: "2026-01-01",
      });
      assert.equal(
        posted.compensationPosted.amount,
        run.total,
        "the year's posted stock compensation is the runs dated in it",
      );
      assert.ok(
        !posted.attention.some(
          (item) => item.kind === "compensation_due" || item.kind === "interest_due",
        ),
        "posted runs are current",
      );
      assert.ok(posted.activity.length > 0 && posted.activity.length <= 8);
      assert.ok(
        posted.activity.every(
          (row, index, rows) => index === 0 || rows[index - 1]!.date >= row.date,
        ),
        "activity reads newest first",
      );

      await db.execute(sql`
      insert into employee_roles (id, org_id, party_id, terminated_on) values (${randomUUID()}, ${w.org.orgId}, ${book.employee}, '2026-10-31')`);
      const departed = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-12-15",
        yearStart: "2026-01-01",
      });
      const departure = departed.attention.find((item) => item.kind === "departed");
      assert.ok(
        departure &&
          departure.kind === "departed" &&
          departure.units === "48000" &&
          departure.date === "2026-10-31",
        "a departed employee's outstanding awards need attention",
      );

      await assert.rejects(
        loadEquityOverview({
          orgId: w.org.orgId,
          actorId: w.outsiderId,
          subsidiaryId: w.org.subsidiaryId,
          asOf: "2026-12-15",
          yearStart: "2026-01-01",
        }),
        refusal("equity_forbidden"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the close checklist counts each legal entity whose stock compensation or note interest is due through period end",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      await seedBook(w);
      const through = "2026-11-30";
      const due = await closeEquityPostings(w.org.orgId, { through, subsidiaryIds: [] });
      assert.deepEqual(
        due.compensation.map((row) => row.subsidiaryId),
        [w.org.subsidiaryId],
      );
      assert.deepEqual(
        due.interest.map((row) => row.subsidiaryId),
        [w.org.subsidiaryId],
      );
      assert.deepEqual(
        await closeEquityPostings(w.org.orgId, { through, subsidiaryIds: [randomUUID()] }),
        { compensation: [], interest: [] },
        "another entity's close sees none of these runs",
      );
      const currency = (
        await db.execute<{ currency: string }>(
          sql`
      select base_currency as currency from subsidiaries where org_id = ${w.org.orgId} and id = ${w.org.subsidiaryId}`,
          "objects",
        )
      )[0]!.currency;
      const before = await equityPostingsDue(w.org.orgId, w.org.subsidiaryId, currency, through);
      assert.ok(before.compensation.due && /[1-9]/.test(before.compensation.amount));

      await withSimClock("2026-12-01T12:00:00Z", async () =>
        applied(await postCompensationRun({ ...entity(w), throughDate: through })),
      );
      const afterCompensation = await closeEquityPostings(w.org.orgId, {
        through,
        subsidiaryIds: [w.org.subsidiaryId],
      });
      assert.deepEqual(
        afterCompensation.compensation,
        [],
        "the posted run resolves the compensation step",
      );
      assert.equal(
        afterCompensation.interest.length,
        1,
        "note interest stays due until its own run posts",
      );
      await withSimClock("2026-12-01T12:00:00Z", async () =>
        applied(await postInterestRun({ ...entity(w), throughDate: through })),
      );
      assert.deepEqual(await closeEquityPostings(w.org.orgId, { through, subsidiaryIds: [] }), {
        compensation: [],
        interest: [],
      });
      assert.equal(
        (await closeEquityPostings(w.org.orgId, { through: "2026-12-31", subsidiaryIds: [] }))
          .compensation.length,
        1,
        "the next period end is due again",
      );

      await setEquityFeature(w.org.orgId, "equity", false);
      assert.deepEqual(
        await closeEquityPostings(w.org.orgId, { through: "2026-12-31", subsidiaryIds: [] }),
        { compensation: [], interest: [] },
        "nothing is due while the feature is off",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
