import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { BenefitsError } from "./errors.ts";
import { db, requireCivilDate } from "./shared.ts";
import {
  requirePeriodShape,
  type IncentiveComputation,
  type IncentiveMeasured,
  type IncentivePeriodBasis,
} from "./incentive-math.ts";
import type { BenefitProgram, BenefitProgramMember } from "./program-types.ts";

/**
 * Project-margin incentives pay each project once, in the settlement whose
 * period holds all of the project's revenue recorded by the settlement date. The base is
 * the project's lifetime margin through the settlement date on the program's named accounts — revenue
 * less cost across every posted or reversed line tagged to the project — less
 * open purchase commitments when the program counts them. A profit pays the
 * profit rate and a loss charges the loss rate, each capped per project. The
 * project manager receives the pool; a manager whose membership names a team
 * role shares it with every member of that role by membership weight.
 * Recipients hold membership on the project's start date, and the manager's
 * membership covers the settlement period. Each
 * recipient's award is the net of their project shares; a net loss carries
 * forward to offset later awards.
 */
export interface ProjectMarginSnapshot {
  readonly metric: "project_margin";
  readonly scope: "company";
  readonly digest: string;
  /** Retained on new snapshots; earlier immutable snapshots predate this field. */
  readonly asOf?: string;
  readonly projects: readonly {
    readonly projectId: string;
    readonly revenueOn: string;
    readonly revenue: string;
    readonly cost: string;
    readonly commitments: string;
    readonly margin: string;
    readonly pool: string;
    readonly shares: readonly {
      readonly employmentId: string;
      readonly weight: string;
      readonly value: string;
    }[];
    readonly unpaid: string | null;
  }[];
  /** Net losses each recipient carries into the next settlement, by employment. */
  readonly carryForward?: Readonly<Record<string, string>>;
}

interface MarginMember extends BenefitProgramMember {
  readonly partyId: string;
}

type SettledAwardRow = {
  snapshot: Record<string, unknown> | null;
  period_from: string;
  period_to: string | null;
  employment_id: string;
  source_key: string | null;
  id: string;
};

function malformedProjectEvidence(): BenefitsError {
  return new BenefitsError(
    "REFUSED",
    "An earlier award in this project-margin program has malformed project evidence in its retained snapshot — retain it and review its award history before settling further periods; ambiguous project evidence is never guessed.",
  );
}

function projectMarginOf(value: unknown): ProjectMarginSnapshot | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw malformedProjectEvidence();
  const snapshot = value as ProjectMarginSnapshot;
  if (snapshot.metric !== "project_margin" || !Array.isArray(snapshot.projects))
    throw malformedProjectEvidence();
  for (const project of snapshot.projects) {
    if (
      typeof project?.projectId !== "string" ||
      project.projectId === "" ||
      !Array.isArray(project.shares)
    )
      throw malformedProjectEvidence();
    for (const share of project.shares) {
      if (
        typeof share?.employmentId !== "string" ||
        share.employmentId === "" ||
        typeof share.value !== "string"
      )
        throw malformedProjectEvidence();
      try {
        toUnits(share.value);
      } catch {
        throw malformedProjectEvidence();
      }
    }
  }
  if (snapshot.carryForward !== undefined) {
    if (
      typeof snapshot.carryForward !== "object" ||
      snapshot.carryForward === null ||
      Array.isArray(snapshot.carryForward)
    )
      throw malformedProjectEvidence();
    for (const value of Object.values(snapshot.carryForward)) {
      if (typeof value !== "string") throw malformedProjectEvidence();
      try {
        toUnits(value);
      } catch {
        throw malformedProjectEvidence();
      }
    }
  }
  return snapshot;
}

/** Native settlements retain their measure under measurement.settlement. */
function nativeProjectMargin(row: SettledAwardRow): ProjectMarginSnapshot | null {
  const measurement = row.snapshot?.measurement as
    { settlement?: { projectMargin?: unknown } } | undefined;
  return projectMarginOf(measurement?.settlement?.projectMargin);
}

function isSourceFirstRow(row: SettledAwardRow): boolean {
  return (
    row.snapshot?.kind === "source-evidenced-first-incentive-v1" ||
    (typeof row.source_key === "string" && row.source_key.startsWith("source-first:"))
  );
}

/** Source-first rows retain project evidence only inside their native preview. */
function sourceFirstProjectMargin(row: SettledAwardRow): ProjectMarginSnapshot | null {
  const evidence = row.snapshot?.sourceEvidence as
    { nativePreview?: { snapshot?: Record<string, unknown> } } | undefined;
  const preview = evidence?.nativePreview?.snapshot;
  if (!preview || typeof preview !== "object" || Array.isArray(preview))
    throw malformedProjectEvidence();
  if (preview.kind === "incentive-measure") {
    if (preview.metric !== "project_margin") {
      if (preview.projectMargin !== undefined) throw malformedProjectEvidence();
      return null;
    }
    const snapshot = projectMarginOf(preview.projectMargin);
    if (!snapshot) throw malformedProjectEvidence();
    return snapshot;
  }
  if (preview.kind === "incentive-native-measure-without-award") {
    const measured = preview.measured as { metric?: unknown } | undefined;
    if (preview.metric !== "project_margin" && measured?.metric !== "project_margin") return null;
    const snapshot = projectMarginOf(preview.measuredSource);
    if (!snapshot) throw malformedProjectEvidence();
    return snapshot;
  }
  throw malformedProjectEvidence();
}

/**
 * Projects already paid by earlier settlements, and the losses carried
 * forward. Native snapshots keep complete latest-state semantics: each
 * native settlement span replaces the carry map once, however many
 * recipient rows duplicate its snapshot. A source-first row is never
 * consumed as a whole native settlement: only projects whose sole share
 * recipient is its own employment are paid, and only that employment's
 * carry merges, chronologically after the native state of its own span.
 * A source-first row with no share for its employment — or no resolvable
 * project evidence in its native preview — consumes nothing.
 */
async function settledProjects(
  orgId: string,
  programId: string,
  periodFrom: string,
): Promise<{ paid: Set<string>; carried: Map<string, bigint> }> {
  const rows = await db.execute<SettledAwardRow>(
    sql`
    select source_snapshot as snapshot, period_from::text as period_from, period_to::text as period_to,
           employment_id::text as employment_id, source_key, id::text as id
      from hrm_benefit_awards
     where org_id = ${orgId} and program_id = ${programId} and status not in ('voided','rejected') and adjusts_award_id is null
     order by period_from, period_to, id
     for share`,
    "objects",
  );
  if (rows.some((row) => row.period_from > periodFrom)) {
    throw new BenefitsError(
      "REFUSED",
      "Later project-margin awards already exist — settle periods chronologically; preserve existing awards and correct history with adjusting awards.",
    );
  }
  const paid = new Set<string>();
  let carried = new Map<string, bigint>();
  const spans = new Map<string, SettledAwardRow[]>();
  for (const row of rows) {
    if (row.period_from >= periodFrom) continue;
    const key = `${row.period_from}|${row.period_to ?? ""}`;
    const span = spans.get(key);
    if (span) span.push(row);
    else spans.set(key, [row]);
  }
  for (const span of spans.values()) {
    let nativeStateApplied = false;
    const sourceRows: SettledAwardRow[] = [];
    for (const row of span) {
      const snapshot = nativeProjectMargin(row);
      if (snapshot) {
        for (const project of snapshot.projects) paid.add(project.projectId);
        if (!nativeStateApplied) {
          carried = new Map(
            Object.entries(snapshot.carryForward ?? {}).map(([employmentId, value]) => [
              employmentId,
              toUnits(value),
            ]),
          );
          nativeStateApplied = true;
        }
      } else if (isSourceFirstRow(row)) {
        sourceRows.push(row);
      } else {
        throw new BenefitsError(
          "REFUSED",
          "An earlier award in this project-margin program has no project evidence — retain it and review its award history before settling further periods.",
        );
      }
    }
    for (const row of sourceRows) {
      const snapshot = sourceFirstProjectMargin(row);
      if (!snapshot) continue;
      const target = row.employment_id.toLowerCase();
      let hasTargetShare = false;
      const soleProjects: string[] = [];
      for (const project of snapshot.projects) {
        const shares = Array.isArray(project.shares) ? project.shares : [];
        if (!shares.some((share) => String(share.employmentId).toLowerCase() === target)) continue;
        hasTargetShare = true;
        if (shares.length === 1) soleProjects.push(project.projectId);
      }
      if (!hasTargetShare || !soleProjects.length) continue;
      for (const projectId of soleProjects) paid.add(projectId);
      const carryEntry = Object.entries(snapshot.carryForward ?? {}).find(
        ([employmentId]) => employmentId.toLowerCase() === target,
      );
      if (carryEntry && typeof carryEntry[1] === "string" && toUnits(carryEntry[1]) < 0n) {
        carried.set(carryEntry[0], toUnits(carryEntry[1]));
      } else {
        for (const employmentId of [...carried.keys()]) {
          if (employmentId.toLowerCase() === target) carried.delete(employmentId);
        }
      }
    }
  }
  return { paid, carried };
}

const PERCENT = 1_000_000n; // percent points in ledger units: 100.0000

export async function measureProjectMarginSettlement(input: {
  readonly orgId: string;
  readonly program: BenefitProgram;
  readonly members: readonly BenefitProgramMember[];
  readonly minorUnits: number;
  readonly basis: IncentivePeriodBasis;
  readonly periodFrom: string;
  readonly periodTo: string;
  readonly revenueAccountIds: readonly string[];
  readonly expenseAccountIds: readonly string[];
  /** Financial sources dated after this date do not enter this settlement. */
  readonly asOf: string;
  /** Read-only reconciliation opt-in: return the full loss measure and carry instead of refusing. */
  readonly allowNativeLossWithoutAward?: boolean;
}): Promise<{
  measured: IncentiveMeasured;
  computation: IncentiveComputation | null;
  nonpayableReason?: string;
  excluded: string[];
  projectMarginSnapshot: ProjectMarginSnapshot;
}> {
  const { orgId, program, periodFrom, periodTo, minorUnits } = input;
  requireCivilDate(periodFrom, "periodFrom");
  requireCivilDate(periodTo, "periodTo");
  requirePeriodShape(program.frequency, periodFrom, periodTo, input.basis);
  if (program.legalEntityId === null || program.percentRate === null)
    throw new BenefitsError(
      "REFUSED",
      "Project-margin settlement needs the responsible employer and a profit-share percentage — correct the draft program.",
    );
  if (!input.revenueAccountIds.length || !input.expenseAccountIds.length)
    throw new BenefitsError(
      "REFUSED",
      "Name the income and cost accounts that make up project margin before settling.",
    );
  const quantum = 10n ** BigInt(4 - minorUnits);
  const excludedProjects = new Set(program.scopeExcludedProjectIds);
  const { paid, carried } = await settledProjects(orgId, program.id, periodFrom);
  const accounts = [...input.revenueAccountIds, ...input.expenseAccountIds];
  const revenueSet = new Set(input.revenueAccountIds);
  // A project settles in the period that holds all of its revenue recorded
  // by the settlement date: one still being billed after the period end
  // waits for the period of its latest revenue.
  requireCivilDate(input.asOf, "asOf");
  const candidates = (
    await db.execute<{
      id: string;
      starts_on: string | null;
      manager_id: string | null;
      revenue_on: string;
    }>(
      sql`
    select p.id::text as id, p.starts_on::text as starts_on, p.manager_id::text as manager_id, max(l.posting_date)::text as revenue_on
      from projects p
      join journal_lines l on l.org_id = p.org_id and l.project_id = p.id
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted','reversed')
     where p.org_id = ${orgId} and (p.subsidiary_id is null or p.subsidiary_id = ${program.legalEntityId}::uuid)
       and l.subsidiary_id = ${program.legalEntityId}::uuid
       and l.account_id = any(${`{${input.revenueAccountIds.join(",")}}`}::uuid[])
       and l.posting_date <= ${input.asOf}::date
     group by p.id
    having max(l.posting_date) <= ${periodTo}::date
     order by p.id`,
      "objects",
    )
  ).filter(
    (p) =>
      !paid.has(p.id) &&
      !excludedProjects.has(p.id) &&
      p.starts_on !== null &&
      p.starts_on >= program.effectiveFrom,
  );
  const excluded: string[] = [];
  if (!candidates.length) return empty(program, periodFrom, periodTo, input.asOf, excluded);
  const ids = candidates.map((p) => p.id);
  const ledger = await db.execute<{ project_id: string; account_id: string; amount: string }>(
    sql`
    select l.project_id::text as project_id, l.account_id::text as account_id, sum(l.amount)::text as amount
      from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted','reversed')
     where l.org_id = ${orgId} and l.subsidiary_id = ${program.legalEntityId}::uuid
       and l.project_id = any(${`{${ids.join(",")}}`}::uuid[])
       and l.account_id = any(${`{${accounts.join(",")}}`}::uuid[])
       and l.posting_date <= ${input.asOf}::date
     group by 1, 2`,
    "objects",
  );
  const commitments = program.includeOpenCommitments
    ? new Map(
        (
          await db.execute<{ project_id: string; amount: string }>(
            sql`
    select coalesce(l.project_id, d.project_id)::text as project_id,
           sum(case when coalesce(l.quantity,0) > 0 then l.amount * greatest(0, 1 - coalesce(l.quantity_billed,0) / l.quantity) else l.amount end)::text as amount
      from documents d join document_lines l on l.org_id = d.org_id and l.document_id = d.id
     where d.org_id = ${orgId} and d.subsidiary_id = ${program.legalEntityId}::uuid
       and (l.subsidiary_id is null or l.subsidiary_id = ${program.legalEntityId}::uuid)
       and d.kind = 'purchase_order' and d.status = 'approved'
       and d.document_date <= ${input.asOf}::date
       and coalesce(l.project_id, d.project_id) = any(${`{${ids.join(",")}}`}::uuid[])
     group by 1`,
            "objects",
          )
        ).map((r) => [r.project_id, toUnits(r.amount)]),
      )
    : new Map<string, bigint>();
  const members = await db.execute<{ id: string; party: string }>(
    sql`
    select id::text as id, worker_party_id::text as party from worker_employments
     where org_id = ${orgId} and id = any(${`{${[...new Set(input.members.map((m) => m.employmentId))].join(",")}}`}::uuid[])`,
    "objects",
  );
  const partyOf = new Map(members.map((m) => [m.id, m.party]));
  const roster: MarginMember[] = input.members.map((m) => ({
    ...m,
    partyId: partyOf.get(m.employmentId) ?? "",
  }));
  const covering = (m: MarginMember, day: string) =>
    m.effectiveFrom <= day && (m.effectiveTo === null || m.effectiveTo >= day);
  const profitRate = toUnits(program.percentRate),
    lossRate = program.lossPercentRate === null ? 0n : toUnits(program.lossPercentRate);
  const profitCap = program.projectProfitCap === null ? null : toUnits(program.projectProfitCap);
  const lossCap = program.projectLossCap === null ? null : toUnits(program.projectLossCap);
  const exact = new Map<string, bigint>();
  const projects: ProjectMarginSnapshot["projects"][number][] = [];
  let measuredTotal = 0n,
    poolTotal = 0n;
  for (const project of candidates) {
    let revenue = 0n,
      cost = 0n;
    for (const row of ledger.filter((r) => r.project_id === project.id)) {
      // Revenue posts credit-negative; costs post debit-positive.
      if (revenueSet.has(row.account_id)) revenue -= toUnits(row.amount);
      else cost += toUnits(row.amount);
    }
    const committed = commitments.get(project.id) ?? 0n;
    const margin = revenue - cost - committed;
    measuredTotal += margin;
    // Exact pool in ledger units scaled by PERCENT; caps bound it either way.
    let pool = margin * (margin >= 0n ? profitRate : lossRate);
    if (margin >= 0n && profitCap !== null && pool > profitCap * PERCENT)
      pool = profitCap * PERCENT;
    if (margin < 0n && lossCap !== null && pool < -lossCap * PERCENT) pool = -lossCap * PERCENT;
    if (program.poolRounding === "pool")
      pool = roundDiv(pool, PERCENT * quantum) * quantum * PERCENT;
    // Eligibility: some membership of the recipient covers the project's
    // start. Team role and weight: the membership covering the period end.
    const eligible = (employmentId: string) =>
      roster.some((m) => m.employmentId === employmentId && covering(m, project.starts_on!));
    const managing =
      project.manager_id === null ? [] : roster.filter((m) => m.partyId === project.manager_id);
    const manager = managing.find((m) => covering(m, periodTo));
    let recipients: { employmentId: string; weight: bigint }[] = [];
    if (manager && eligible(manager.employmentId)) {
      if (manager.role) {
        recipients = roster
          .filter(
            (m) =>
              m.role === manager.role &&
              covering(m, periodTo) &&
              m.weight !== null &&
              toUnits(m.weight) > 0n &&
              eligible(m.employmentId),
          )
          .map((m) => ({ employmentId: m.employmentId, weight: toUnits(m.weight!) }));
      } else recipients = [{ employmentId: manager.employmentId, weight: 1n }];
    }
    const totalWeight = recipients.reduce((sum, r) => sum + r.weight, 0n);
    const shares = recipients.map((r) => {
      // Each share rounds once to the payable quantum.
      const value = roundDiv(pool * r.weight, totalWeight * PERCENT * quantum) * quantum;
      exact.set(r.employmentId, (exact.get(r.employmentId) ?? 0n) + value);
      return { employmentId: r.employmentId, weight: fromUnits(r.weight), value: fromUnits(value) };
    });
    poolTotal += roundDiv(pool, PERCENT);
    const unpaid = recipients.length
      ? null
      : project.manager_id === null
        ? "The project has no manager."
        : "The project manager holds no program membership covering the project start and this period.";
    if (unpaid) excluded.push(`${project.id}: ${unpaid}`);
    projects.push({
      projectId: project.id,
      revenueOn: project.revenue_on,
      revenue: fromUnits(revenue),
      cost: fromUnits(cost),
      commitments: fromUnits(committed),
      margin: fromUnits(margin),
      pool: fromUnits(roundDiv(pool, PERCENT)),
      shares,
      unpaid,
    });
  }
  // Earlier net losses offset this period's shares; a recipient who still nets
  // a loss is paid nothing and carries the balance forward.
  for (const [employmentId, value] of carried)
    exact.set(employmentId, (exact.get(employmentId) ?? 0n) + value);
  const recipients = [...exact].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const carryForward = Object.fromEntries(
    recipients
      .filter(([, value]) => value < 0n)
      .map(([employmentId, value]) => [employmentId, fromUnits(value)]),
  );
  const awarded = recipients.filter(([, value]) => value > 0n);
  const totalAwarded = awarded.reduce((sum, [, value]) => sum + value, 0n);
  const body = {
    metric: "project_margin" as const,
    scope: "company" as const,
    asOf: input.asOf,
    projects,
    ...(Object.keys(carryForward).length ? { carryForward } : {}),
  };
  const projectMarginSnapshot = {
    ...body,
    digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  };
  const measured: IncentiveMeasured = {
    metric: "project_margin",
    scope: "company",
    sourceAccountIds: accounts,
    periodFrom,
    periodTo,
    value: fromUnits(measuredTotal),
    currency: program.currency,
  };
  if (Object.keys(carryForward).length && !awarded.length) {
    const nonpayableReason =
      "Every recipient nets a project-margin loss this period, so no award can carry the losses forward — settle a longer span that includes a payment.";
    if (!input.allowNativeLossWithoutAward) throw new BenefitsError("REFUSED", nonpayableReason);
    return { measured, computation: null, nonpayableReason, excluded, projectMarginSnapshot };
  }
  const computation: IncentiveComputation = {
    measuredValue: fromUnits(measuredTotal),
    poolValue: fromUnits(poolTotal),
    thresholdMet: true,
    currency: program.currency,
    totalAwarded: fromUnits(totalAwarded),
    undistributed: fromUnits(poolTotal - totalAwarded),
    excludedZero: [],
    summaryLines: [
      `${program.code}: ${program.percentRate}% of project profit${program.lossPercentRate !== null ? `, ${program.lossPercentRate}% of project loss` : ""}, each project once in the period holding all its recorded revenue; ${projects.length} project(s) this period.`,
      program.includeOpenCommitments
        ? "Margin is revenue less cost on the named accounts, less open purchase commitments."
        : "Margin is revenue less cost on the named accounts.",
      program.poolRounding === "pool"
        ? `Each project pool rounds to ${minorUnits} places before it is shared.`
        : `Each share rounds once to ${minorUnits} places from the exact pool.`,
      "A recipient's net loss carries forward and offsets later awards.",
    ],
    recipients: awarded.map(([employmentId, value]) => ({
      employmentId,
      share: "project manager",
      grossValue: fromUnits(value),
      value: fromUnits(value),
      capped: false,
      explanation: `${fromUnits(value)} ${program.currency} net across ${projects.filter((p) => p.shares.some((s) => s.employmentId === employmentId)).length} project(s).`,
    })),
  };
  return { measured, computation, excluded, projectMarginSnapshot };
}

function empty(
  program: BenefitProgram,
  periodFrom: string,
  periodTo: string,
  asOf: string,
  excluded: string[],
) {
  const body = { metric: "project_margin" as const, scope: "company" as const, asOf, projects: [] };
  return {
    measured: {
      metric: "project_margin" as const,
      scope: "company" as const,
      sourceAccountIds: [],
      periodFrom,
      periodTo,
      value: "0.0000",
      currency: program.currency,
    },
    computation: {
      measuredValue: "0.0000",
      poolValue: "0.0000",
      thresholdMet: true,
      currency: program.currency,
      totalAwarded: "0.0000",
      undistributed: "0.0000",
      excludedZero: [],
      summaryLines: [`${program.code}: no project first earned revenue in this period.`],
      recipients: [],
    } as IncentiveComputation,
    excluded,
    projectMarginSnapshot: {
      ...body,
      digest: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    },
  };
}
