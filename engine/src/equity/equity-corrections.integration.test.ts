import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { renderRefusal } from "../platform/catalog-refusal.ts";
import { EQUITY_REFUSALS } from "./refusals/index.ts";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { EQUITY_ACTION_SUBJECT_KIND } from "../flows/equity-actions-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
import { withSimClock } from "../platform/clock.ts";
import { db } from "../platform/db.ts";
import { createSandbox, deleteSandbox } from "../sandbox/lifecycle.ts";
import {
  dropScratchOrgReporting,
  seedApprovalFlow,
  seedPostingAccount,
} from "../testing/fixtures.ts";
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
import { electMfnTerms, reverseMfnElection } from "./mfn.ts";
import { loadEquityOverview } from "./overview.ts";
import { nextEquityRunPeriod } from "./period-postings.ts";
import { instrumentBalance, postEquityEntry, requireConsiderationAccount } from "./posting.ts";
import {
  listSecurities,
  loadCapTableView,
  loadSecurityDetail,
  loadStructure,
} from "./read-model.ts";
import { amendRound, voidRound } from "./rounds.ts";
import { issueSecurity } from "./securities.ts";
import { loadEquityBook, loadEquityBookAtEvent } from "./store.ts";
import {
  amendShareClass,
  changePlanReserve,
  createPlan,
  createRound,
  createShareClass,
  recordSplit,
} from "./structure.ts";

// Governed actions a Flow holds release through the registered equity handler.
installEngineSeams();

const DB = !!process.env.OPENBOOKS_DB_URL;

const manage = (w: EquityWorld) => ({ orgId: w.org.orgId, actorId: w.managerId });
const entity = (w: EquityWorld) => ({ ...manage(w), subsidiaryId: w.org.subsidiaryId });
const ledger = (groups: { units: bigint }[]) =>
  -groups.reduce((sum, group) => sum + group.units, 0n);

/** Monthly periods on the scratch calendar from `from` through `through` (YYYY-MM), for histories older than the world's. */
async function seedMonths(w: EquityWorld, from: string, through: string): Promise<void> {
  const calendarId = (
    await db.execute<{ fiscal_calendar_id: string }>(
      sql`
    select fiscal_calendar_id from accounting_periods where org_id = ${w.org.orgId} and id = ${w.org.periodId}`,
      "objects",
    )
  )[0]!.fiscal_calendar_id;
  for (
    let [year, month] = from.split("-").map(Number) as [number, number];
    `${year}-${String(month).padStart(2, "0")}` <= through;
    month === 12 ? ((year += 1), (month = 1)) : (month += 1)
  ) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${w.org.orgId}, ${year}, ${month}, ${key}, ${`${key}-01`}::date,
        ((${`${key}-01`}::date + interval '1 month') - interval '1 day')::date, false, ${calendarId})`);
  }
}

async function periodId(w: EquityWorld, name: string): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`select id from accounting_periods where org_id = ${w.org.orgId} and name = ${name}`,
      "objects",
    )
  )[0]!.id;
}

async function closeGl(w: EquityWorld, name: string): Promise<void> {
  await setPeriodLockState({
    orgId: w.org.orgId,
    periodId: await periodId(w, name),
    bookId: w.org.bookId,
    module: "gl",
    state: "closed",
    actorId: w.managerId,
    reason: "Month closed after review",
  });
}

async function commonShares(
  w: EquityWorld,
  quantity: string,
  issueDate = "2026-07-01",
  shareClassId = w.commonClassId,
) {
  return issueSecurity({
    ...entity(w),
    kind: "share",
    holderPartyId: w.holderId,
    issueDate,
    shareClassId,
    quantity,
    pricePerShare: "0.0001",
    considerationAccountId: w.org.accounts.bank,
  });
}

async function preferred(w: EquityWorld, code: string) {
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

async function equityActionRequestCount(w: EquityWorld): Promise<number> {
  return (
    await db.execute<{ n: number }>(
      sql`select count(*)::int as n from equity_action_requests where org_id = ${w.org.orgId}`,
      "objects",
    )
  )[0]!.n;
}

async function openGate(w: EquityWorld, requestId: string): Promise<string> {
  return (
    await db.execute<{ id: string }>(
      sql`
    select id from flow_gates where org_id = ${w.org.orgId} and subject_id = ${requestId} and status in ('pending', 'escalated')`,
      "objects",
    )
  )[0]!.id;
}

test(
  "an early-exercise deposit reads as of the date on the ledger and on the vesting schedule, and copies keep it attributed",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true, policyFrom: "2024-01-01" });
    let sandboxId: string | null = null;
    try {
      await seedMonths(w, "2024-01", "2026-06");
      const common = (
        await createShareClass({
          ...entity(w),
          code: "CS24",
          name: "Common 2024",
          kind: "common",
          effectiveOn: "2024-01-01",
          authorizedShares: "10000000",
          parValue: "0.0001",
        })
      ).id;
      const grant = await issueSecurity({
        ...entity(w),
        kind: "option",
        holderPartyId: w.holderId,
        issueDate: "2024-03-04",
        shareClassId: common,
        quantity: "288000",
        pricePerShare: "0.12",
        optionType: "iso",
        earlyExercise: true,
        unvestedRepurchaseBasis: "cost",
        expirationDate: "2034-03-04",
        vestingStart: "2024-03-04",
        vestingMonths: 48,
        cliffMonths: 12,
        vestingFrequency: "monthly",
        valuation: {
          sharePrice: "0.12",
          volatilityPercent: "55",
          riskFreeRatePercent: "4.20",
          expectedTermYears: "6.08",
          dividendYieldPercent: "0",
          attribution: "straight_line",
        },
      });
      const exercise = await recordSecurityEvent({
        ...manage(w),
        securityId: grant.id,
        kind: "exercise",
        effectiveOn: "2024-03-18",
        quantity: "288000",
        considerationAccountId: w.org.accounts.bank,
      });
      const certificate = exercise.resultingSecurityId!;
      applied(await postCompensationRun({ ...entity(w), throughDate: "2026-02-28" }));
      const deposit = async (asOf: string) =>
        (await loadSecurityDetail({ ...manage(w), securityId: certificate, asOf })).restricted!;

      assert.deepEqual(
        [(await deposit("2024-06-27")).depositHeld, (await deposit("2024-06-27")).depositUnvested],
        ["34560.0000", "34560.0000"],
        "nothing has vested or been released",
      );
      const today = await deposit("2026-10-19");
      assert.equal(
        today.depositHeld,
        "18000.0000",
        "the runs through February released 138,000 shares' deposit",
      );
      assert.equal(
        today.depositUnvested,
        "12240.0000",
        "the schedule has vested 186,000 shares by today",
      );

      await withSimClock("2027-01-04T12:00:00Z", async () =>
        applied(await postCompensationRun({ ...entity(w), throughDate: "2026-12-31" })),
      );
      assert.equal(
        (await deposit("2026-10-19")).depositHeld,
        "18000.0000",
        "a later run does not reach back before its date",
      );
      assert.equal(
        (await deposit("2026-12-31")).depositHeld,
        "10800.0000",
        "the December run releases 60,000 more shares' deposit",
      );
      assert.equal((await deposit("2026-12-31")).depositUnvested, "10800.0000");

      // A line copied under its source environment's identity is attributed through the copy chain.
      const seed = randomUUID();
      await db.execute(sql`update orgs set sandbox_seed = ${seed}::uuid where id = ${w.org.orgId}`);
      const sourceIdentity = randomUUID();
      const copied = (
        await db.execute<{ id: string }>(
          sql`select public.ob_rebase(${sourceIdentity}::uuid, ${seed}::uuid)::text as id`,
          "objects",
        )
      )[0]!.id;
      await db.execute(sql`
      insert into equity_securities (id, org_id, subsidiary_id, security_number, kind, holder_party_id, share_class_id, issue_date, quantity, price_per_share, currency, created_by)
      values (${copied}, ${w.org.orgId}, ${w.org.subsidiaryId}, 'CS24-COPY', 'share', ${w.holderId}, ${common}, '2026-07-01', 100, 0.12, 'CAD', ${w.managerId})`);
      await postEquityEntry(db, {
        orgId: w.org.orgId,
        subsidiaryId: w.org.subsidiaryId,
        currency: "CAD",
        postingDate: "2026-07-01",
        entryNumberBase: "EQ-COPY",
        memo: "Copied deposit",
        idempotencyKey: `copied-deposit:${sourceIdentity}`,
        actorId: w.managerId,
        auditAction: "equity.test",
        auditChanges: {},
        legs: [
          { accountId: w.org.accounts.bank, units: 120_000n },
          {
            accountId: w.accounts.deposit,
            units: -120_000n,
            balance: { securityId: sourceIdentity, role: "deposit" },
          },
        ],
      });
      assert.deepEqual(
        await instrumentBalance(db, w.org.orgId, w.org.subsidiaryId, copied, "deposit"),
        [],
        "the line names the source identity",
      );
      const attributed = (
        await db.execute<{ n: number }>(
          sql`select public.equity_attribute_copied_instrument_lines(${w.org.orgId}::uuid) as n`,
          "objects",
        )
      )[0]!.n;
      assert.equal(
        attributed,
        1,
        "only the copied line is attributed; lines naming this tenant's securities stand as recorded",
      );
      assert.equal(
        ledger(await instrumentBalance(db, w.org.orgId, w.org.subsidiaryId, copied, "deposit")),
        120_000n,
      );
      assert.equal(
        (
          await db.execute<{ n: number }>(
            sql`select public.equity_attribute_copied_instrument_lines(${w.org.orgId}::uuid) as n`,
            "objects",
          )
        )[0]!.n,
        0,
        "a replay records nothing again",
      );
      await db.execute(sql`update orgs set sandbox_seed = null where id = ${w.org.orgId}`);

      // A masked copy of the tenant rebases each line's identity with the security it names.
      const sandbox = await createSandbox({
        productionOrgId: w.org.orgId,
        name: `Equity copy ${randomUUID()}`,
        createdBy: w.managerId,
      });
      sandboxId = sandbox.sandboxId;
      const sandboxSeed = (
        await db.execute<{ seed: string }>(
          sql`select sandbox_seed::text as seed from orgs where id = ${sandbox.sandboxOrgId}`,
          "objects",
        )
      )[0]!.seed;
      const rebase = async (id: string) =>
        (
          await db.execute<{ id: string }>(
            sql`select public.ob_rebase(${id}::uuid, ${sandboxSeed}::uuid)::text as id`,
            "objects",
          )
        )[0]!.id;
      const held = await instrumentBalance(
        db,
        sandbox.sandboxOrgId,
        await rebase(w.org.subsidiaryId),
        await rebase(certificate),
        "deposit",
        "2026-10-19",
      );
      assert.equal(
        ledger(held),
        180_000_000n,
        "the copy carries the certificate's deposit under its own identity",
      );
      assert.equal(
        ledger(
          await instrumentBalance(
            db,
            sandbox.sandboxOrgId,
            await rebase(w.org.subsidiaryId),
            await rebase(copied),
            "deposit",
          ),
        ),
        120_000n,
        "attributions copy with their lines",
      );
    } finally {
      const sandboxes = (
        await db.execute<{ id: string }>(
          sql`select id from sandboxes where production_org_id = ${w.org.orgId}`,
          "objects",
        )
      ).map((row) => row.id);
      for (const id of new Set([...(sandboxId ? [sandboxId] : []), ...sandboxes]))
        await deleteSandbox(id);
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "the instrument an MFN election adopted cannot be voided while the election stands, and conversions use only terms that stand",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await commonShares(w, "1000000");
      const seriesSeed = await preferred(w, "SS");
      const mfn = await issueSecurity({
        ...entity(w),
        kind: "safe",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        considerationAmount: "50000",
        considerationAccountId: w.org.accounts.bank,
        safeType: "pre_money",
        mfn: true,
      });
      const better = await issueSecurity({
        ...entity(w),
        kind: "safe",
        holderPartyId: w.holderId,
        issueDate: "2026-07-05",
        considerationAmount: "100000",
        considerationAccountId: w.org.accounts.bank,
        safeType: "post_money",
        valuationCap: "400000",
        discountPercent: "20",
      });
      await assert.rejects(
        electMfnTerms({
          ...manage(w),
          securityId: mfn.id,
          sourceSecurityId: better.id,
          effectiveOn: "2026-07-03",
          reason: "Holder adopts the later SAFE's terms",
        }),
        (error: unknown) =>
          error instanceof EquityError &&
          error.code === "equity_mfn_not_better" &&
          error.field === "effectiveOn" &&
          error.remedy.includes("on or after Jul 5, 2026"),
        "an election dated before the later SAFE was issued names the date it can take effect",
      );
      const election = await electMfnTerms({
        ...manage(w),
        securityId: mfn.id,
        sourceSecurityId: better.id,
        effectiveOn: "2026-07-10",
        reason: "Holder adopts the later SAFE's terms",
      });
      const voidBetter = {
        ...manage(w),
        securityId: better.id,
        kind: "void" as const,
        effectiveOn: "2026-07-12",
        reason: "Recorded in error",
      };
      await assert.rejects(
        recordSecurityEvent(voidBetter),
        (error: unknown) =>
          error instanceof EquityError &&
          error.code === "equity_void_mfn_source" &&
          /Reverse the MFN election/.test(error.remedy),
      );

      // The pre-election terms and the election stay visible on the SAFE.
      const elected = await loadSecurityDetail({
        ...manage(w),
        securityId: mfn.id,
        asOf: "2026-07-11",
      });
      assert.deepEqual(elected.convertible!.issuedTerms, {
        valuationCap: null,
        discountPercent: null,
        safeType: "pre_money",
      });
      assert.equal(elected.convertible!.valuationCap, "400000.0000");
      assert.deepEqual(
        elected.mfn!.elections.map((row) => [
          row.kind,
          row.effectiveOn,
          row.before.valuationCap,
          row.valuationCap,
          row.standing,
        ]),
        [["mfn_election", "2026-07-10", null, "400000.0000", "in_force"]],
      );

      await assert.rejects(
        reverseMfnElection({
          ...manage(w),
          securityId: mfn.id,
          amendmentId: election.amendmentId!,
          effectiveOn: "2026-07-09",
          reason: "Entered against the wrong instrument",
        }),
        refusal("equity_date_invalid"),
      );
      applied(
        await reverseMfnElection({
          ...manage(w),
          securityId: mfn.id,
          amendmentId: election.amendmentId!,
          effectiveOn: "2026-07-12",
          reason: "Entered against the wrong instrument",
        }),
      );
      const reversed = await loadSecurityDetail({
        ...manage(w),
        securityId: mfn.id,
        asOf: "2026-07-12",
      });
      assert.equal(
        reversed.convertible!.valuationCap,
        null,
        "the SAFE carries its own terms again",
      );
      assert.deepEqual(
        reversed.mfn!.elections.map((row) => [row.kind, row.standing, row.reversedOn]),
        [
          ["mfn_election", "reversed", "2026-07-12"],
          ["mfn_reversal", null, null],
        ],
      );
      applied(await recordSecurityEvent(voidBetter));

      // A conversion recorded on terms whose source was already void (the void dated the day before it and recorded
      // ahead of it, as history recorded before conversions were held back from such terms) is flagged, and is
      // corrected by voiding its certificate, reversing the election and converting again.
      const second = await issueSecurity({
        ...entity(w),
        kind: "safe",
        holderPartyId: w.holderId,
        issueDate: "2026-07-15",
        considerationAmount: "50000",
        considerationAccountId: w.org.accounts.bank,
        safeType: "pre_money",
        mfn: true,
      });
      const capped = await issueSecurity({
        ...entity(w),
        kind: "safe",
        holderPartyId: w.holderId,
        issueDate: "2026-07-16",
        considerationAmount: "100000",
        considerationAccountId: w.org.accounts.bank,
        safeType: "post_money",
        valuationCap: "400000",
      });
      const secondElection = await electMfnTerms({
        ...manage(w),
        securityId: second.id,
        sourceSecurityId: capped.id,
        effectiveOn: "2026-07-17",
        reason: "Holder adopts the capped SAFE's terms",
      });
      const round = await createRound({
        ...entity(w),
        name: "Seed",
        shareClassId: seriesSeed,
        closedOn: "2026-08-31",
        pricePerShare: "1.00",
        preMoneyValuation: "1000000",
      });
      const converted = await recordSecurityEvent({
        ...manage(w),
        securityId: second.id,
        kind: "convert",
        effectiveOn: "2026-08-31",
        roundId: round.id,
        reason: "Converted in the Seed",
      });
      const onCap = (
        await loadSecurityDetail({
          ...manage(w),
          securityId: converted.resultingSecurityId!,
          asOf: "2026-08-31",
        })
      ).security.quantity;
      await db.execute(sql`
      insert into equity_security_events (org_id, subsidiary_id, security_id, kind, effective_on, reason, created_by, created_at)
      values (${w.org.orgId}, ${w.org.subsidiaryId}, ${capped.id}, 'void', '2026-08-30', 'Recorded in error', ${w.managerId},
        (select created_at - interval '1 minute' from equity_security_events where org_id = ${w.org.orgId} and security_id = ${second.id} and kind = 'convert'))`);
      const flagged = await loadSecurityDetail({
        ...manage(w),
        securityId: second.id,
        asOf: "2026-09-02",
      });
      assert.deepEqual(
        [
          flagged.convertible!.invalidConversionTerms?.sourceSecurityId,
          flagged.convertible!.invalidConversionTerms?.sourceVoidedOn,
        ],
        [capped.id, "2026-08-30"],
        "a void dated before the conversion still flags it",
      );
      const overview = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-09-02",
        yearStart: "2026-01-01",
      });
      assert.equal(
        overview.attention[0]?.kind,
        "conversion_terms_void",
        "the inconsistent conversion leads the work needing attention",
      );
      applied(
        await recordSecurityEvent({
          ...manage(w),
          securityId: converted.resultingSecurityId!,
          kind: "void",
          effectiveOn: "2026-08-31",
          reason: "Converted on terms that were voided",
        }),
      );
      await assert.rejects(
        recordSecurityEvent({
          ...manage(w),
          securityId: second.id,
          kind: "convert",
          effectiveOn: "2026-08-31",
          roundId: round.id,
          reason: "Converted on the SAFE's own terms",
        }),
        (error: unknown) =>
          error instanceof EquityError &&
          error.code === "equity_conversion_terms_void" &&
          /Reverse the MFN election on .* dated on or before Aug 31, 2026/.test(error.remedy),
        "a SAFE does not convert while its election names a void instrument's terms",
      );
      applied(
        await reverseMfnElection({
          ...manage(w),
          securityId: second.id,
          amendmentId: secondElection.amendmentId!,
          effectiveOn: "2026-08-31",
          reason: "Adopted terms were entered in error",
        }),
      );
      const again = await recordSecurityEvent({
        ...manage(w),
        securityId: second.id,
        kind: "convert",
        effectiveOn: "2026-08-31",
        roundId: round.id,
        reason: "Converted on the SAFE's own terms",
      });
      const ownTerms = (
        await loadSecurityDetail({
          ...manage(w),
          securityId: again.resultingSecurityId!,
          asOf: "2026-09-02",
        })
      ).security.quantity;
      assert.equal(
        ownTerms,
        "50000",
        "an uncapped SAFE without discount converts at the round price",
      );
      assert.notEqual(onCap, ownTerms);
      assert.equal(
        (await loadSecurityDetail({ ...manage(w), securityId: second.id, asOf: "2026-09-03" }))
          .convertible!.invalidConversionTerms,
        null,
      );
      assert.ok(
        !(
          await loadEquityOverview({ ...entity(w), asOf: "2026-09-03", yearStart: "2026-01-01" })
        ).attention.some((item) => item.kind === "conversion_terms_void"),
      );

      // Converted instruments show nothing outstanding and name what they became.
      const safes = await listSecurities({ ...entity(w), asOf: "2026-09-03", kind: "safe" });
      const row = safes.rows.find((item) => item.id === second.id)!;
      assert.deepEqual(
        [row.status, row.principal, row.outstandingAmount, row.resultingSecurityId],
        ["converted", "50000.0000", "0.0000", again.resultingSecurityId],
      );
      const table = await loadCapTableView({ ...entity(w), asOf: "2026-09-03" });
      assert.equal(
        table.table.convertibles.find((item) => item.securityId === second.id)!
          .outstandingPrincipal,
        "0.0000",
      );

      assert.ok(again.eventId, "an applied conversion records its event identity");
      const lateIssue = await commonShares(w, "1000", "2026-07-01");
      const recorded = await loadEquityBookAtEvent(db, w.org.orgId, again.eventId);
      assert.ok(
        recorded?.securities.some((item) => item.id === again.resultingSecurityId),
        "the recording transaction is included",
      );
      assert.ok(
        !recorded?.securities.some((item) => item.id === lateIssue.id),
        "later records stay outside the recorded snapshot even when their issue date is earlier",
      );
      assert.ok(
        (await loadEquityBook(db, w.org.orgId, w.org.subsidiaryId)).securities.some(
          (item) => item.id === lateIssue.id,
        ),
        "current readers keep the later record",
      );
      assert.equal(
        await loadEquityBookAtEvent(db, randomUUID(), again.eventId),
        null,
        "an event cannot select another organization’s recorded state",
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "a round's pre-money must agree with its price and the shares before it, and the round is amended or voided through governed actions",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await commonShares(w, "2000000");
      const seriesA = await preferred(w, "A2");
      const base = {
        ...entity(w),
        name: "Series A-2",
        shareClassId: seriesA,
        closedOn: "2026-08-15",
        pricePerShare: "3.50",
      };
      await assert.rejects(
        createRound({ ...base, preMoneyValuation: "1000" }),
        (error: unknown) => {
          if (
            !(error instanceof EquityError) ||
            error.code !== "equity_round_pre_money_inconsistent"
          )
            return false;
          assert.match(
            error.message,
            /CA\$1,000\.00 .* CA\$3\.5000 times the 2,000,000 fully diluted shares .*CA\$7,000,000\.00/,
          );
          assert.match(
            error.remedy,
            /pre-money valuation of CA\$7,000,000\.00 or a price per share of CA\$0\.0005/,
          );
          assert.match(
            renderRefusal(EQUITY_REFUSALS[error.key].message, error.values, "de-DE"),
            /2\.000\.000 fully diluted/,
          );
          return true;
        },
      );
      const round = await createRound({ ...base, preMoneyValuation: "7000000" });
      await assert.rejects(
        amendRound({
          ...manage(w),
          roundId: round.id,
          effectiveOn: "2026-08-20",
          preMoneyValuation: "9000000",
          reason: "Valuation per the signed term sheet",
        }),
        refusal("equity_round_pre_money_inconsistent"),
      );
      applied(
        await amendRound({
          ...manage(w),
          roundId: round.id,
          effectiveOn: "2026-08-20",
          preMoneyValuation: "9000000",
          preMoneyBasisReason:
            "The term sheet counts the post-money pool increase in the pre-money",
          reason: "Valuation per the signed term sheet",
        }),
      );
      const issued = await issueSecurity({
        ...entity(w),
        kind: "share",
        holderPartyId: w.holderId,
        issueDate: "2026-08-15",
        shareClassId: seriesA,
        roundId: round.id,
        quantity: "100000",
        considerationAccountId: w.org.accounts.bank,
      });
      await assert.rejects(
        amendRound({
          ...manage(w),
          roundId: round.id,
          effectiveOn: "2026-08-21",
          pricePerShare: "4.00",
          preMoneyValuation: "8000000",
          reason: "Repriced in error",
        }),
        refusal("equity_round_has_securities"),
      );
      await assert.rejects(
        voidRound({
          ...manage(w),
          roundId: round.id,
          effectiveOn: "2026-08-21",
          reason: "Recorded in error",
        }),
        refusal("equity_round_has_securities"),
      );
      const structure = await loadStructure({ ...entity(w), asOf: "2026-08-31" });
      assert.deepEqual(
        structure.rounds.map((row) => [
          row.name,
          row.preMoneyValuation,
          row.preMoneyBasisReason !== null,
          row.fullyDilutedBefore,
        ]),
        [["Series A-2", "9000000.0000", true, "2000000"]],
      );
      const beforeIssue = (await loadStructure({ ...entity(w), asOf: "2026-08-10" })).rounds.find(
        (row) => row.id === round.id,
      );
      assert.ok(beforeIssue);
      assert.deepEqual(
        [beforeIssue.raised, beforeIssue.sharesIssued],
        ["0.0000", "0"],
        "future certificates do not change historical fundraising totals",
      );
      assert.ok(
        beforeIssue.liveSecurities.some((security) => security.id === issued.id),
        "current correction dependencies retain the future certificate",
      );

      // With an Equity action Flow the void waits for its approver, then applies.
      applied(
        await recordSecurityEvent({
          ...manage(w),
          securityId: issued.id,
          kind: "void",
          effectiveOn: "2026-08-21",
          reason: "Issued against the wrong round",
        }),
      );
      await seedApprovalFlow(w.org.orgId, {
        subjectKind: EQUITY_ACTION_SUBJECT_KIND,
        assignees: [{ type: "user", userId: w.approverId }],
        mode: "any",
      });
      const held = await voidRound({
        ...manage(w),
        roundId: round.id,
        effectiveOn: "2026-08-22",
        reason: "Recorded in error",
      });
      assert.equal(held.status, "pending_approval");
      assert.equal(
        (await loadStructure({ ...entity(w), asOf: "2026-08-31" })).rounds.length,
        1,
        "nothing applies while the void waits",
      );
      await decideGate({
        gateId: await openGate(w, held.requestId),
        decision: "approved",
        userId: w.approverId,
      });
      const after = await loadStructure({ ...entity(w), asOf: "2026-08-31" });
      assert.deepEqual(
        [after.rounds.length, after.voidedRounds.map((row) => row.name)],
        [0, ["Series A-2"]],
      );
      assert.equal(
        (await loadEquityOverview({ ...entity(w), asOf: "2026-08-31", yearStart: "2026-01-01" }))
          .latestRound,
        null,
        "a voided round leaves the latest priced round",
      );
      await assert.rejects(
        createRound({ ...base, preMoneyValuation: "7000000" }),
        refusal("equity_round_name_taken"),
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "runs are offered and posted only for open periods with activity due, and an as-of overview reads runs as of its date",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld({ lifecycle: true });
    try {
      const run = (kind: "compensation" | "interest", today: string) =>
        nextEquityRunPeriod({ ...entity(w), kind, today });
      assert.equal(await run("interest", "2026-10-19"), null, "no note: no interest run is due");
      await assert.rejects(
        postInterestRun({ ...entity(w), throughDate: "2026-07-31" }),
        refusal("equity_run_nothing_due"),
      );

      const rsu = await issueSecurity({
        ...entity(w),
        kind: "rsu",
        holderPartyId: w.holderId,
        issueDate: "2026-07-01",
        shareClassId: w.commonClassId,
        quantity: "1200",
        vestingStart: "2026-07-01",
        vestingMonths: 12,
        cliffMonths: 0,
        vestingFrequency: "monthly",
        valuation: { sharePrice: "1.00", attribution: "straight_line" },
      });
      await closeGl(w, "2026-07");
      assert.equal(
        (await run("compensation", "2026-10-19"))?.name,
        "P08 FY2026",
        "the closed month is skipped, and the period reads with its fiscal label",
      );
      await assert.rejects(
        postCompensationRun({ ...entity(w), throughDate: "2026-07-31" }),
        refusal("equity_period_closed"),
      );
      // A period still under way on the organization's business date is not run.
      await withSimClock("2026-12-20T12:00:00Z", async () => {
        const requests = await equityActionRequestCount(w);
        await assert.rejects(
          postCompensationRun({ ...entity(w), throughDate: "2026-12-31" }),
          (error: unknown) =>
            error instanceof EquityError &&
            error.code === "equity_run_period_not_ended" &&
            error.field === "throughDate" &&
            error.message.includes("after today (Dec 20, 2026)"),
        );
        assert.equal(
          (await previewCompensationRun({ ...entity(w), throughDate: "2026-12-31" })).blocked?.code,
          "equity_run_period_not_ended",
          "the preview names why it cannot post yet",
        );
        assert.equal(
          await equityActionRequestCount(w),
          requests,
          "nothing is submitted for a period that has not ended",
        );
      });
      await withSimClock("2027-01-04T12:00:00Z", async () => {
        assert.equal(
          (await previewCompensationRun({ ...entity(w), throughDate: "2026-12-31" })).blocked,
          null,
        );
        applied(await postCompensationRun({ ...entity(w), throughDate: "2026-12-31" }));
      });
      assert.equal(
        await run("compensation", "2026-10-19"),
        null,
        "after a run through December nothing earlier is offered",
      );
      await assert.rejects(
        previewCompensationRun({ ...entity(w), throughDate: "2026-09-30" }),
        refusal("equity_compensation_run_backdated"),
      );

      // The full grant-date value, and the cost once forfeitures are taken out, labelled apart.
      applied(
        await recordSecurityEvent({
          ...manage(w),
          securityId: rsu.id,
          kind: "forfeit",
          effectiveOn: "2026-12-31",
          quantity: "600",
          reason: "Employment ended",
        }),
      );
      const cost = (
        await loadSecurityDetail({ ...manage(w), securityId: rsu.id, asOf: "2026-12-31" })
      ).compensation!;
      assert.deepEqual(
        [cost.grantDateValue, cost.expectedAfterForfeitures],
        ["1200.0000", "600.0000"],
      );

      // A note's interest runs reach past an as-of date without the overview reading them as of today.
      await issueSecurity({
        ...entity(w),
        kind: "note",
        holderPartyId: w.holderId,
        issueDate: "2026-08-01",
        considerationAmount: "100000",
        considerationAccountId: w.org.accounts.bank,
        interestRatePercent: "8",
        interestBasis: "simple",
        interestDayCount: "actual_365",
      });
      await withSimClock("2026-11-02T12:00:00Z", async () =>
        applied(await postInterestRun({ ...entity(w), throughDate: "2026-10-31" })),
      );
      const past = await loadEquityOverview({
        ...entity(w),
        asOf: "2026-09-15",
        yearStart: "2026-01-01",
      });
      assert.equal(
        past.postings?.interest.refusal,
        null,
        "runs through a later date are not compared with the as-of date's accrual",
      );
      assert.equal(past.postings?.interest.due, false);
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);

test(
  "refusals name the remedy that fits the action and accept only cash accounts for consideration",
  { skip: !DB },
  async () => {
    const w = await setupEquityWorld();
    try {
      await commonShares(w, "1000000");
      const plan = (
        await createPlan({
          ...entity(w),
          code: "EIP",
          name: "Equity incentive plan",
          shareClassId: w.commonClassId,
          effectiveOn: "2026-07-01",
          reservedShares: "500000",
          recycleForfeited: true,
          recycleExpired: true,
          recycleRepurchased: false,
        })
      ).id;
      await issueSecurity({
        ...entity(w),
        kind: "option",
        holderPartyId: w.holderId,
        issueDate: "2026-07-02",
        shareClassId: w.commonClassId,
        planId: plan,
        quantity: "200000",
        pricePerShare: "0.10",
        optionType: "nso",
        expirationDate: "2036-07-02",
        valuation: {
          sharePrice: "0.10",
          volatilityPercent: "55",
          riskFreeRatePercent: "4.00",
          expectedTermYears: "6",
          dividendYieldPercent: "0",
          attribution: "straight_line",
        },
      });
      await assert.rejects(
        amendShareClass({
          ...manage(w),
          shareClassId: w.commonClassId,
          kind: "authorized_shares",
          effectiveOn: "2026-07-10",
          authorizedShares: "800000",
          reason: "Charter amendment",
        }),
        (error: unknown) =>
          error instanceof EquityError &&
          error.remedy.startsWith("Authorize at least 1,500,000 shares of class CS"),
      );
      await assert.rejects(
        changePlanReserve({
          ...manage(w),
          planId: plan,
          effectiveOn: "2026-07-10",
          shareDelta: "-400000",
          reason: "Board reduced the reserve",
        }),
        (error: unknown) =>
          error instanceof EquityError &&
          error.remedy.startsWith(
            "Remove no more than 300,000 shares from the reserve of plan EIP",
          ) &&
          renderRefusal(EQUITY_REFUSALS[error.key].remedy, error.values, "fr-FR").includes(
            "300 000",
          ),
      );
      // Activity on another class does not hold back a split of a class with none of its own.
      const quiet = await preferred(w, "QP");
      const later = await commonShares(w, "1000", "2026-07-20");
      applied(
        await recordSecurityEvent({
          ...manage(w),
          securityId: later.id,
          kind: "void",
          effectiveOn: "2026-10-01",
          reason: "Issued in error",
        }),
      );
      applied(
        await recordSplit({
          ...manage(w),
          shareClassId: quiet,
          effectiveOn: "2026-08-01",
          ratioNumerator: "2",
          ratioDenominator: "1",
          reason: "Two-for-one split of the series",
        }),
      );
      const prepaid = await seedPostingAccount(
        w.org.orgId,
        "1395",
        "Prepaid expenses",
        "asset_current_other",
      );
      await assert.rejects(
        requireConsiderationAccount(db, w.org.orgId, prepaid),
        refusal("equity_consideration_account_invalid"),
      );
      assert.equal(
        await requireConsiderationAccount(db, w.org.orgId, w.org.accounts.bank),
        w.org.accounts.bank,
      );
    } finally {
      await dropScratchOrgReporting(w.org.orgId);
    }
  },
);
