import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromUnits, roundDiv, toUnits } from "../../money/money.ts";
import { BenefitsError } from "./errors.ts";
import { db, requireCivilDate } from "./shared.ts";
import { requirePeriodShape, type IncentiveComputation, type IncentiveMeasured, type IncentivePeriodBasis } from "./incentive-math.ts";
import type { BenefitProgram, BenefitProgramMember } from "./program-types.ts";

/**
 * Project-margin incentives pay each project once, in the settlement whose
 * period holds all of the project's revenue recorded by the settlement date. The base is
 * the project's lifetime margin on the program's named accounts — revenue
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
  readonly projects: readonly {
    readonly projectId: string;
    readonly revenueOn: string;
    readonly revenue: string;
    readonly cost: string;
    readonly commitments: string;
    readonly margin: string;
    readonly pool: string;
    readonly shares: readonly { readonly employmentId: string; readonly weight: string; readonly value: string }[];
    readonly unpaid: string | null;
  }[];
  /** Net losses each recipient carries into the next settlement, by employment. */
  readonly carryForward?: Readonly<Record<string, string>>;
}

interface MarginMember extends BenefitProgramMember { readonly partyId: string }

/** Projects already paid by earlier settlements, and the losses the latest one carried forward. */
async function settledProjects(orgId: string, programId: string, periodFrom: string): Promise<{ paid: Set<string>; carried: Map<string, bigint> }> {
  const rows = (await db.execute<{ snapshot: Record<string, unknown> | null; period_from: string }>(sql`
    select source_snapshot as snapshot, period_from::text as period_from from hrm_benefit_awards
     where org_id = ${orgId} and program_id = ${programId} and status not in ('voided','rejected') and adjusts_award_id is null
     for share`)).rows;
  if (rows.some((row) => row.period_from > periodFrom)) {
    throw new BenefitsError("REFUSED", "Later project-margin awards already exist — settle periods chronologically; preserve existing awards and correct history with adjusting awards.");
  }
  const paid = new Set<string>();
  let latest: { from: string; snapshot: ProjectMarginSnapshot } | null = null;
  for (const row of rows) {
    if (row.period_from >= periodFrom) continue;
    const snapshot = ((row.snapshot?.measurement as { settlement?: { projectMargin?: ProjectMarginSnapshot } } | undefined)?.settlement?.projectMargin);
    if (!snapshot) throw new BenefitsError("REFUSED", "An earlier award in this project-margin program has no project evidence — retain it and review its award history before settling further periods.");
    for (const project of snapshot.projects) paid.add(project.projectId);
    if (!latest || row.period_from > latest.from) latest = { from: row.period_from, snapshot };
  }
  const carried = new Map(Object.entries(latest?.snapshot.carryForward ?? {}).map(([employmentId, value]) => [employmentId, toUnits(value)]));
  return { paid, carried };
}

const PERCENT = 1_000_000n; // percent points in ledger units: 100.0000

export async function measureProjectMarginSettlement(input: {
  readonly orgId: string; readonly program: BenefitProgram; readonly members: readonly BenefitProgramMember[];
  readonly minorUnits: number; readonly basis: IncentivePeriodBasis; readonly periodFrom: string; readonly periodTo: string;
  readonly revenueAccountIds: readonly string[]; readonly expenseAccountIds: readonly string[];
  /** Revenue recorded after this date has not happened yet for this settlement. */
  readonly asOf: string;
}): Promise<{ measured: IncentiveMeasured; computation: IncentiveComputation; excluded: string[]; projectMarginSnapshot: ProjectMarginSnapshot }> {
  const { orgId, program, periodFrom, periodTo, minorUnits } = input;
  requireCivilDate(periodFrom, "periodFrom"); requireCivilDate(periodTo, "periodTo");
  requirePeriodShape(program.frequency, periodFrom, periodTo, input.basis);
  if (program.legalEntityId === null || program.percentRate === null) throw new BenefitsError("REFUSED", "Project-margin settlement needs the responsible employer and a profit-share percentage — correct the draft program.");
  if (!input.revenueAccountIds.length || !input.expenseAccountIds.length) throw new BenefitsError("REFUSED", "Name the income and cost accounts that make up project margin before settling.");
  const quantum = 10n ** BigInt(4 - minorUnits);
  const excludedProjects = new Set(program.scopeExcludedProjectIds);
  const { paid, carried } = await settledProjects(orgId, program.id, periodFrom);
  const accounts = [...input.revenueAccountIds, ...input.expenseAccountIds];
  const revenueSet = new Set(input.revenueAccountIds);
  // A project settles in the period that holds all of its revenue recorded
  // by the settlement date: one still being billed after the period end
  // waits for the period of its latest revenue.
  requireCivilDate(input.asOf, "asOf");
  const candidates = (await db.execute<{ id: string; starts_on: string | null; manager_id: string | null; revenue_on: string }>(sql`
    select p.id::text as id, p.starts_on::text as starts_on, p.manager_id::text as manager_id, max(l.posting_date)::text as revenue_on
      from projects p
      join journal_lines l on l.org_id = p.org_id and l.project_id = p.id
      join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted','reversed')
     where p.org_id = ${orgId} and (p.subsidiary_id is null or p.subsidiary_id = ${program.legalEntityId}::uuid)
       and l.account_id = any(${`{${input.revenueAccountIds.join(",")}}`}::uuid[])
       and l.posting_date <= ${input.asOf}::date
     group by p.id
    having max(l.posting_date) <= ${periodTo}::date
     order by p.id`)).rows.filter((p) => !paid.has(p.id) && !excludedProjects.has(p.id)
       && p.starts_on !== null && p.starts_on >= program.effectiveFrom);
  const excluded: string[] = [];
  if (!candidates.length) return empty(program, periodFrom, periodTo, excluded);
  const ids = candidates.map((p) => p.id);
  const ledger = (await db.execute<{ project_id: string; account_id: string; amount: string }>(sql`
    select l.project_id::text as project_id, l.account_id::text as account_id, sum(l.amount)::text as amount
      from journal_lines l join journal_entries e on e.org_id = l.org_id and e.id = l.entry_id and e.status in ('posted','reversed')
     where l.org_id = ${orgId} and l.project_id = any(${`{${ids.join(",")}}`}::uuid[])
       and l.account_id = any(${`{${accounts.join(",")}}`}::uuid[])
     group by 1, 2`)).rows;
  const commitments = program.includeOpenCommitments ? new Map((await db.execute<{ project_id: string; amount: string }>(sql`
    select coalesce(l.project_id, d.project_id)::text as project_id,
           sum(case when coalesce(l.quantity,0) > 0 then l.amount * greatest(0, 1 - coalesce(l.quantity_billed,0) / l.quantity) else l.amount end)::text as amount
      from documents d join document_lines l on l.org_id = d.org_id and l.document_id = d.id
     where d.org_id = ${orgId} and d.kind = 'purchase_order' and d.status = 'approved'
       and coalesce(l.project_id, d.project_id) = any(${`{${ids.join(",")}}`}::uuid[])
     group by 1`)).rows.map((r) => [r.project_id, toUnits(r.amount)])) : new Map<string, bigint>();
  const members = (await db.execute<{ id: string; party: string }>(sql`
    select id::text as id, worker_party_id::text as party from worker_employments
     where org_id = ${orgId} and id = any(${`{${[...new Set(input.members.map((m) => m.employmentId))].join(",")}}`}::uuid[])`)).rows;
  const partyOf = new Map(members.map((m) => [m.id, m.party]));
  const roster: MarginMember[] = input.members.map((m) => ({ ...m, partyId: partyOf.get(m.employmentId) ?? "" }));
  const covering = (m: MarginMember, day: string) => m.effectiveFrom <= day && (m.effectiveTo === null || m.effectiveTo >= day);
  const profitRate = toUnits(program.percentRate), lossRate = program.lossPercentRate === null ? 0n : toUnits(program.lossPercentRate);
  const profitCap = program.projectProfitCap === null ? null : toUnits(program.projectProfitCap);
  const lossCap = program.projectLossCap === null ? null : toUnits(program.projectLossCap);
  const exact = new Map<string, bigint>();
  const projects: ProjectMarginSnapshot["projects"][number][] = [];
  let measuredTotal = 0n, poolTotal = 0n;
  for (const project of candidates) {
    let revenue = 0n, cost = 0n;
    for (const row of ledger.filter((r) => r.project_id === project.id)) {
      // Revenue posts credit-negative; costs post debit-positive.
      if (revenueSet.has(row.account_id)) revenue -= toUnits(row.amount); else cost += toUnits(row.amount);
    }
    const committed = commitments.get(project.id) ?? 0n;
    const margin = revenue - cost - committed;
    measuredTotal += margin;
    // Exact pool in ledger units scaled by PERCENT; caps bound it either way.
    let pool = margin * (margin >= 0n ? profitRate : lossRate);
    if (margin >= 0n && profitCap !== null && pool > profitCap * PERCENT) pool = profitCap * PERCENT;
    if (margin < 0n && lossCap !== null && pool < -lossCap * PERCENT) pool = -lossCap * PERCENT;
    if (program.poolRounding === "pool") pool = roundDiv(pool, PERCENT * quantum) * quantum * PERCENT;
    // Eligibility: some membership of the recipient covers the project's
    // start. Team role and weight: the membership covering the period end.
    const eligible = (employmentId: string) => roster.some((m) => m.employmentId === employmentId && covering(m, project.starts_on!));
    const managing = project.manager_id === null ? [] : roster.filter((m) => m.partyId === project.manager_id);
    const manager = managing.find((m) => covering(m, periodTo));
    let recipients: { employmentId: string; weight: bigint }[] = [];
    if (manager && eligible(manager.employmentId)) {
      if (manager.role) {
        recipients = roster.filter((m) => m.role === manager.role && covering(m, periodTo) && m.weight !== null && toUnits(m.weight) > 0n && eligible(m.employmentId))
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
    const unpaid = recipients.length ? null : project.manager_id === null ? "The project has no manager." : "The project manager holds no program membership covering the project start and this period.";
    if (unpaid) excluded.push(`${project.id}: ${unpaid}`);
    projects.push({ projectId: project.id, revenueOn: project.revenue_on, revenue: fromUnits(revenue), cost: fromUnits(cost), commitments: fromUnits(committed),
      margin: fromUnits(margin), pool: fromUnits(roundDiv(pool, PERCENT)), shares, unpaid });
  }
  // Earlier net losses offset this period's shares; a recipient who still nets
  // a loss is paid nothing and carries the balance forward.
  for (const [employmentId, value] of carried) exact.set(employmentId, (exact.get(employmentId) ?? 0n) + value);
  const recipients = [...exact].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const carryForward = Object.fromEntries(recipients.filter(([, value]) => value < 0n).map(([employmentId, value]) => [employmentId, fromUnits(value)]));
  const awarded = recipients.filter(([, value]) => value > 0n);
  if (Object.keys(carryForward).length && !awarded.length) {
    throw new BenefitsError("REFUSED", "Every recipient nets a project-margin loss this period, so no award can carry the losses forward — settle a longer span that includes a payment.");
  }
  const totalAwarded = awarded.reduce((sum, [, value]) => sum + value, 0n);
  const body = { metric: "project_margin" as const, scope: "company" as const, projects, ...(Object.keys(carryForward).length ? { carryForward } : {}) };
  const projectMarginSnapshot = { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
  const computation: IncentiveComputation = {
    measuredValue: fromUnits(measuredTotal), poolValue: fromUnits(poolTotal), thresholdMet: true, currency: program.currency,
    totalAwarded: fromUnits(totalAwarded), undistributed: fromUnits(poolTotal - totalAwarded), excludedZero: [],
    summaryLines: [
      `${program.code}: ${program.percentRate}% of project profit${program.lossPercentRate !== null ? `, ${program.lossPercentRate}% of project loss` : ""}, each project once in the period holding all its recorded revenue; ${projects.length} project(s) this period.`,
      program.includeOpenCommitments ? "Margin is revenue less cost on the named accounts, less open purchase commitments." : "Margin is revenue less cost on the named accounts.",
      program.poolRounding === "pool" ? `Each project pool rounds to ${minorUnits} places before it is shared.` : `Each share rounds once to ${minorUnits} places from the exact pool.`,
      "A recipient's net loss carries forward and offsets later awards.",
    ],
    recipients: awarded.map(([employmentId, value]) => ({
      employmentId, share: "project manager", grossValue: fromUnits(value), value: fromUnits(value), capped: false,
      explanation: `${fromUnits(value)} ${program.currency} net across ${projects.filter((p) => p.shares.some((s) => s.employmentId === employmentId)).length} project(s).`,
    })),
  };
  return { measured: { metric: "project_margin", scope: "company", sourceAccountIds: accounts, periodFrom, periodTo, value: fromUnits(measuredTotal), currency: program.currency }, computation, excluded, projectMarginSnapshot };
}

function empty(program: BenefitProgram, periodFrom: string, periodTo: string, excluded: string[]) {
  const body = { metric: "project_margin" as const, scope: "company" as const, projects: [] };
  return {
    measured: { metric: "project_margin" as const, scope: "company" as const, sourceAccountIds: [], periodFrom, periodTo, value: "0.0000", currency: program.currency },
    computation: { measuredValue: "0.0000", poolValue: "0.0000", thresholdMet: true, currency: program.currency, totalAwarded: "0.0000", undistributed: "0.0000", excludedZero: [],
      summaryLines: [`${program.code}: no project first earned revenue in this period.`], recipients: [] } as IncentiveComputation,
    excluded,
    projectMarginSnapshot: { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") },
  };
}
