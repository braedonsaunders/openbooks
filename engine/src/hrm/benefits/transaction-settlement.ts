import {
  transactionRoleRecipient,
  type TransactionRoleEvidence,
} from "./transaction-role-recipient.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { apportion, fromUnits, toUnits } from "../../money/money.ts";
import { fromQuantityUnits, toQuantityUnits } from "../../money/quantity.ts";
import { BenefitsError } from "./errors.ts";
import { db, requireCivilDate } from "./shared.ts";
import {
  partitionMembers,
  requirePeriodShape,
  type IncentiveComputation,
  type IncentiveMeasured,
  type IncentivePeriodBasis,
} from "./incentive-math.ts";
import {
  applyTransactionGroupLimitOverrides,
  computeTransactionIncentive,
  type TransactionIncentiveLimit,
  type TransactionIncentiveResult,
} from "./transaction-incentive-math.ts";
import {
  measureTransactionIncentiveSources,
  type TransactionIncentiveSourceSnapshot,
} from "./transaction-incentive-sources.ts";
import {
  readTransactionPolicy,
  validateTransactionPolicy,
  type BenefitTransactionPolicy,
} from "./transaction-policy.ts";
import type { BenefitProgram, BenefitProgramMember } from "./program-types.ts";

export interface TransactionSettlementSnapshot {
  readonly metric: "transactions";
  readonly scope: "company";
  readonly value: string;
  readonly currency: string;
  readonly entryCount: number;
  readonly lineCount: number;
  readonly digest: string;
  readonly policy: BenefitTransactionPolicy;
  readonly source: TransactionIncentiveSourceSnapshot;
  readonly result: TransactionIncentiveResult;
  readonly recipientContexts?: readonly (TransactionRoleEvidence & {
    id: string;
    work_date: string;
  })[];
  readonly priorAwards: readonly {
    readonly id: string;
    readonly value: string;
    readonly status: string;
    readonly employmentId: string;
    readonly groups: readonly { readonly groupId: string; readonly value: string }[];
  }[];
}
interface PriorAward extends Record<string, unknown> {
  id: string;
  employment_id: string;
  value: string;
  status: string;
  adjusts_award_id: string | null;
  source_snapshot: Record<string, unknown>;
  period_from: string;
  period_to: string | null;
}

/** Actual obligations consume a ceiling; negative recoveries release room only after approval. */
async function consumption(
  orgId: string,
  programId: string,
  from: string,
): Promise<{
  totals: Map<string, bigint>;
  evidence: TransactionSettlementSnapshot["priorAwards"];
  usedSources: Set<string>;
}> {
  const rows = await db.execute<PriorAward>(
    sql`select id,employment_id,value::text,status,adjusts_award_id,source_snapshot,period_from::text,period_to::text from hrm_benefit_awards where org_id=${orgId} and program_id=${programId} order by id for share`,
    "objects",
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  if (
    !rows.some((r) => r.period_from === from && !["voided", "rejected"].includes(r.status)) &&
    rows.some((r) => r.period_from > from && !["voided", "rejected"].includes(r.status))
  )
    throw new BenefitsError(
      "REFUSED",
      "Later transaction awards already consume these group ceilings — settle new periods chronologically; preserve existing awards and use their native adjusting-award action for corrections.",
    );
  const totals = new Map<string, bigint>(),
    usedSources = new Set<string>();
  const evidence: TransactionSettlementSnapshot["priorAwards"][number][] = [];
  for (const row of rows) {
    if (row.period_from >= from || ["voided", "rejected"].includes(row.status)) continue;
    if ((row.period_to ?? row.period_from) >= from)
      throw new BenefitsError(
        "REFUSED",
        "An earlier award overlaps this source period — review the existing award's period before settling a new span.",
      );
    const signed = toUnits(row.value);
    if (signed < 0n && !["approved", "queued", "delivered"].includes(row.status)) continue;
    let root = row;
    const seen = new Set<string>();
    while (root.adjusts_award_id !== null) {
      if (seen.has(root.id))
        throw new BenefitsError(
          "REFUSED",
          "The adjusting-award chain contains a cycle — retain the award records and have the administrator repair the invalid correction relationship before settlement.",
        );
      seen.add(root.id);
      const parent = byId.get(root.adjusts_award_id);
      if (!parent || parent.employment_id !== row.employment_id)
        throw new BenefitsError(
          "REFUSED",
          "An adjusting award has no matching recipient's original source evidence — review its native award history before settlement.",
        );
      root = parent;
    }
    const frozen = (
      root.source_snapshot?.measurement as { settlement?: Record<string, unknown> } | undefined
    )?.settlement;
    const snapshot = frozen?.transaction as TransactionSettlementSnapshot | undefined;
    if (!snapshot || snapshot.metric !== "transactions")
      throw new BenefitsError(
        "REFUSED",
        "A previous award in this transaction program has no transaction allocation evidence — retain it and review its native award history before settling further periods.",
      );
    for (const line of snapshot.source.lines) usedSources.add(line.sourceId);
    const weights = snapshot.result.groups
      .map((g) => ({
        groupId: g.groupId,
        value: toUnits(
          g.recipients.find((r) => r.employmentId === row.employment_id)?.value ?? "0",
        ),
      }))
      .filter((g) => g.value > 0n)
      .sort((a, b) => a.groupId.localeCompare(b.groupId));
    if (!weights.length)
      throw new BenefitsError(
        "REFUSED",
        "A previous recipient award has no group allocation — review its original transaction award evidence before consuming a ceiling.",
      );
    // Corrections retain their original recipient's group proportions. The
    // existing currency quantum makes this split payable and deterministic.
    const precision = frozen?.minorUnits;
    if (
      typeof precision !== "number" ||
      !Number.isInteger(precision) ||
      precision < 0 ||
      precision > 4
    )
      throw new BenefitsError(
        "REFUSED",
        "A stored transaction award has no valid currency quantum — review its original source evidence before consuming a ceiling.",
      );
    const quantum = 10n ** BigInt(4 - precision);
    if (signed % quantum !== 0n)
      throw new BenefitsError(
        "REFUSED",
        "A stored transaction award is finer than its recorded currency quantum — reconcile the original award evidence before settlement.",
      );
    const split = apportion(
      (signed < 0n ? -signed : signed) / quantum,
      weights.map((g) => g.value),
    );
    const groups = weights.map((g, i) => {
      const value = split[i]! * quantum * (signed < 0n ? -1n : 1n);
      totals.set(g.groupId, (totals.get(g.groupId) ?? 0n) + value);
      return { groupId: g.groupId, value: fromUnits(value) };
    });
    evidence.push({
      id: row.id,
      employmentId: row.employment_id,
      value: row.value,
      status: row.status,
      groups,
    });
  }
  return { totals, evidence, usedSources };
}

/**
 * A budget ceiling: for projects of the policy's type, the ceiling percentage
 * of the program items on the project's original budget baseline, consumed by
 * the program rate on every earlier source line of that project whether or
 * not a share was paid. Other projects carry no ceiling. A capped project
 * without an original baseline has nothing sold to cap against, so its
 * ceiling is zero and the measured evidence names it.
 */
async function budgetCeilings(
  orgId: string,
  program: BenefitProgram,
  policy: BenefitTransactionPolicy,
  projectIds: readonly string[],
  periodFrom: string,
  rate: string,
): Promise<Map<string, TransactionIncentiveLimit>> {
  if (program.valuation !== "percent")
    throw new BenefitsError(
      "REFUSED",
      "A budget ceiling consumes the program percentage of earlier sources — value the program as a percent of amount.",
    );
  const projects = await db.execute<{
    id: string;
    project_type_id: string | null;
    budget: string | null;
  }>(
    sql`
    select p.id::text as id, p.project_type_id::text as project_type_id,
           (select sum(bl.price)::text from project_budget_baselines b join project_budget_baseline_lines bl on bl.org_id=b.org_id and bl.baseline_id=b.id
             where b.org_id=p.org_id and b.project_id=p.id and b.sequence=1 and bl.item_id=any(${`{${policy.itemIds.join(",")}}`}::uuid[])) as budget
      from projects p where p.org_id=${orgId} and p.id=any(${`{${projectIds.join(",")}}`}::uuid[]) for share of p`,
    "objects",
  );
  if (projects.length !== projectIds.length)
    throw new BenefitsError(
      "REFUSED",
      "A budget ceiling groups sources by project — group the program by the project dimension so every group is a native project.",
    );
  const status = policy.documentKind === "customer_invoice" ? "posted" : "approved";
  const sourceDate =
    policy.dateBasis === "work_date"
      ? sql`coalesce(l.work_from,d.document_date)`
      : sql`d.document_date`;
  const earlier = new Map(
    (
      await db.execute<{ project_id: string; amount: string }>(
        sql`
    select coalesce(l.project_id,d.project_id)::text as project_id, sum(l.amount)::text as amount
      from documents d join document_lines l on l.org_id=d.org_id and l.document_id=d.id
     where d.org_id=${orgId} and d.subsidiary_id=${program.legalEntityId} and d.kind=${policy.documentKind} and d.status=${status}
       and ${sourceDate} < ${periodFrom}::date and l.item_id=any(${`{${policy.itemIds.join(",")}}`}::uuid[])
       and coalesce(l.project_id,d.project_id)=any(${`{${projectIds.join(",")}}`}::uuid[])
     group by 1`,
        "objects",
      )
    ).map((r) => [r.project_id, r.amount]),
  );
  const rateUnits = toUnits(rate);
  return new Map<string, TransactionIncentiveLimit>(
    projects.map((p) => {
      if (policy.capProjectTypeId && p.project_type_id !== policy.capProjectTypeId)
        return [p.id, { kind: "none" as const }];
      const consumed = fromUnits((toUnits(earlier.get(p.id) ?? "0") * rateUnits) / 1_000_000n);
      return [
        p.id,
        {
          kind: "percent_of_base" as const,
          base: p.budget ?? "0",
          rate: policy.capPercent!,
          previouslyAwarded: consumed,
          consumption: "measured" as const,
        },
      ];
    }),
  );
}

/** Same measurement and allocation feeds native preview and settlement. */
export async function measureTransactionSettlement(input: {
  readonly orgId: string;
  readonly actorId: string;
  readonly program: BenefitProgram;
  readonly members: readonly BenefitProgramMember[];
  /** Rules from the revision governing the period; undefined reads the current rules. */
  readonly policy?: BenefitTransactionPolicy | null;
  readonly minorUnits: number;
  readonly basis: IncentivePeriodBasis;
  readonly periodFrom: string;
  readonly periodTo: string;
}): Promise<{
  measured: IncentiveMeasured;
  computation: IncentiveComputation;
  excluded: string[];
  transactionSnapshot: TransactionSettlementSnapshot;
}> {
  const { orgId, actorId, program, periodFrom, periodTo, minorUnits } = input;
  requireCivilDate(periodFrom, "periodFrom");
  requireCivilDate(periodTo, "periodTo");
  requirePeriodShape(program.frequency, periodFrom, periodTo, input.basis);
  if (
    periodFrom < program.effectiveFrom ||
    (program.effectiveTo !== null && periodTo > program.effectiveTo)
  )
    throw new BenefitsError(
      "REFUSED",
      "The source period is outside this program's effective dates — choose a covered span or its effective replacement program.",
    );
  if (
    program.legalEntityId === null ||
    program.allocation !== "responsibility" ||
    !["percent", "per_unit"].includes(program.valuation)
  )
    throw new BenefitsError(
      "REFUSED",
      "Transaction settlement needs the responsible employer, dated responsibility allocation and a percent or per-unit rate — correct the draft program before activation.",
    );
  const policy =
    input.policy === undefined ? await readTransactionPolicy(db, orgId, program.id) : input.policy;
  if (!policy)
    throw new BenefitsError(
      "REFUSED",
      "Configure this program's Transaction rules before measuring an incentive.",
    );
  await validateTransactionPolicy(db, orgId, program.legalEntityId, policy, program.currency);
  const rate = program.valuation === "percent" ? program.percentRate : program.fixedAmount;
  if (rate === null)
    throw new BenefitsError(
      "REFUSED",
      "The program has no configured valuation rate — record its percent or amount per unit before activation.",
    );
  const status = policy.documentKind === "customer_invoice" ? "posted" : "approved";
  // The work date is the line's recorded work start; lines without one use the document date.
  const sourceDate =
    policy.dateBasis === "work_date"
      ? sql`coalesce(l.work_from,d.document_date)`
      : sql`d.document_date`;
  const selected = await db.execute<{ id: string }>(
    sql`select l.id from documents d join document_lines l on l.org_id=d.org_id and l.document_id=d.id where d.org_id=${orgId} and d.subsidiary_id=${program.legalEntityId} and d.kind=${policy.documentKind} and d.status=${status} and ${sourceDate} between ${periodFrom}::date and ${periodTo}::date and l.item_id=any(${`{${policy.itemIds.join(",")}}`}::uuid[]) order by d.id,l.id for share of d,l`,
    "objects",
  );
  if (!selected.length)
    throw new BenefitsError(
      "REFUSED",
      "No approved transactions match this program's items and document-date period — review the native source selection before settlement; no empty award is recorded.",
    );
  const source = await measureTransactionIncentiveSources({
    orgId,
    actorId,
    legalEntityId: program.legalEntityId,
    currency: program.currency,
    documentKind: policy.documentKind,
    itemIds: policy.itemIds,
    lineIds: selected.map((r) => r.id),
    groupingSegmentId: policy.groupingSegmentId,
  });
  const prior = await consumption(orgId, program.id, periodFrom);
  const covered = new Set(
    partitionMembers(input.members, periodFrom, periodTo).covered.map((r) => r.employmentId),
  );
  // Roles recorded on each source: its field ticket (the document itself, or
  // the ticket the line references) and its project.
  const retainContexts = policy.positions.some(
    (position) => position.fallbackOnlyWhenContextAbsent === true,
  );
  if (retainContexts) {
    // Serialize role changes with the new context-bound financial measurement.
    await db.execute(sql`select ft.document_id from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id
      join field_tickets ft on ft.org_id=l.org_id and ft.document_id=(case when d.kind='field_ticket' then d.id else l.field_ticket_id end)
      where l.org_id=${orgId} and l.id=any(${`{${selected.map((row) => row.id).join(",")}}`}::uuid[]) order by ft.document_id for share of ft`);
    await db.execute(sql`select p.id from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id
      join projects p on p.org_id=l.org_id and p.id=coalesce(l.project_id,d.project_id)
      where l.org_id=${orgId} and l.id=any(${`{${selected.map((row) => row.id).join(",")}}`}::uuid[]) order by p.id for share of p`);
  }
  const roles = new Map(
    (
      await db.execute<TransactionRoleEvidence & { id: string; work_date: string }>(
        sql`
    select l.id::text as id, coalesce(l.work_from,d.document_date)::text as work_date,
           (case when d.kind='field_ticket' then d.id else l.field_ticket_id end)::text as ticket_reference,
           ft.document_id::text as ticket_id,coalesce(l.project_id,d.project_id)::text as project_reference,p.id::text as project_id,
           ft.foreman_party_id::text as ticket_foreman, ft.superintendent_party_id::text as ticket_superintendent,
           p.foreman_id::text as project_foreman, p.manager_id::text as project_manager
      from document_lines l join documents d on d.org_id=l.org_id and d.id=l.document_id
      left join field_tickets ft on ft.org_id=d.org_id and ft.document_id=(case when d.kind='field_ticket' then d.id else l.field_ticket_id end)
      left join projects p on p.org_id=d.org_id and p.id=coalesce(l.project_id,d.project_id)
     where l.org_id=${orgId} and l.id=any(${`{${selected.map((r) => r.id).join(",")}}`}::uuid[])`,
        "objects",
      )
    ).map((r) => [r.id, r]),
  );
  const memberByParty = new Map(
    (
      await db.execute<{ employment_id: string; party: string }>(
        sql`select id::text as employment_id,worker_party_id::text as party from worker_employments where org_id=${orgId} and id=any(${`{${[...covered].join(",")}}`}::uuid[])`,
        "objects",
      )
    ).map((r) => [r.party, r.employment_id]),
  );
  const forfeit = policy.unassignedShare === "forfeit";
  const facts = source.lines.map((line) => {
    if (prior.usedSources.has(line.sourceId))
      throw new BenefitsError(
        "REFUSED",
        `Source line ${line.sourceId} already belongs to an earlier award — preserve that obligation and use its native adjusting-award action instead of paying the line again.`,
      );
    const role = roles.get(line.sourceId);
    const occurredOn =
      policy.dateBasis === "work_date" ? (role?.work_date ?? line.documentDate) : line.documentDate;
    const recipients = policy.positions.flatMap((position) => {
      const source = position.recipientSource ?? "assignment";
      if (source !== "assignment") {
        const holder = transactionRoleRecipient(
          source,
          position.fallbackSource ?? null,
          position.fallbackOnlyWhenContextAbsent,
          role,
        );
        const employmentId = holder ? memberByParty.get(holder) : undefined;
        if (employmentId) return [{ shareKey: position.key, employmentId }];
        if (forfeit) return [];
        throw new BenefitsError(
          "REFUSED",
          `Source ${line.documentNumber} has no program member recorded as its ${position.name} — record the role on the source or enroll its holder, or set the program to forfeit unassigned shares.`,
        );
      }
      const binding = policy.responsibilities.filter(
        (r) =>
          r.groupId === line.groupId &&
          r.positionKey === position.key &&
          r.effectiveFrom <= occurredOn &&
          (r.effectiveTo === null || r.effectiveTo >= occurredOn),
      );
      if (binding.length === 1 && covered.has(binding[0]!.employmentId))
        return [{ shareKey: position.key, employmentId: binding[0]!.employmentId }];
      if (forfeit && binding.length <= 1) return [];
      throw new BenefitsError(
        "REFUSED",
        `Source ${line.documentNumber} group ${line.groupId} needs one dated ${position.name} assignment and full-period program membership — record the assignment and enroll the employment, or select its covered manual span; missing shares are never redistributed.`,
      );
    });
    return {
      sourceId: line.sourceId,
      groupId: line.groupId,
      occurredOn,
      currency: line.currency,
      amount: line.amount,
      quantity: line.quantity,
      recipients,
    };
  });
  const groupIds = [...new Set(facts.map((r) => r.groupId))].sort();
  const budgetCaps =
    policy.capPercent !== null && policy.capPercent !== undefined
      ? await budgetCeilings(orgId, program, policy, groupIds, periodFrom, rate)
      : null;
  const groups = groupIds.map((groupId) => {
    if (budgetCaps) return { groupId, limit: budgetCaps.get(groupId)! };
    const limit = policy.limits.find((r) => r.groupId === groupId);
    if (!limit)
      throw new BenefitsError(
        "REFUSED",
        `Group ${groupId} has no ceiling decision — record an amount or explicitly select no limit in Transaction rules before settlement.`,
      );
    return {
      groupId,
      limit:
        limit.kind === "none"
          ? { kind: "none" as const }
          : {
              kind: "amount" as const,
              amount: limit.amount!,
              previouslyAwarded: fromUnits(prior.totals.get(groupId) ?? 0n),
            },
    };
  });
  const effectiveGroups = budgetCaps
    ? applyTransactionGroupLimitOverrides(groups, policy.limits, prior.totals)
    : groups;
  const valuationPolicy = {
    currency: program.currency,
    minorUnits,
    periodFrom,
    periodTo,
    valuation:
      program.valuation === "percent"
        ? ("percent_of_amount" as const)
        : ("amount_per_unit" as const),
    rate,
    recipientShares: policy.positions.map((r) => ({ key: r.key, weight: r.weight })),
    unassignedShare: policy.unassignedShare ?? "refuse",
    rounding: policy.rounding ?? "per_group",
  };
  const result = computeTransactionIncentive(valuationPolicy, facts, effectiveGroups);
  const uncapped = computeTransactionIncentive(
    valuationPolicy,
    facts,
    effectiveGroups.map((g) => ({ groupId: g.groupId, limit: { kind: "none" as const } })),
  );
  const measuredValue =
    program.valuation === "percent"
      ? fromUnits(facts.reduce((s, r) => s + toUnits(r.amount), 0n))
      : fromQuantityUnits(facts.reduce((s, r) => s + toQuantityUnits(r.quantity), 0n));
  const potential = fromUnits(result.groups.reduce((s, g) => s + toUnits(g.potentialAward), 0n));
  const computation: IncentiveComputation = {
    measuredValue,
    poolValue: potential,
    thresholdMet: true,
    currency: program.currency,
    totalAwarded: result.totalAwarded,
    undistributed: fromUnits(toUnits(potential) - toUnits(result.totalAwarded)),
    excludedZero: [],
    summaryLines: [
      `${program.code}: ${rate} ${program.valuation === "percent" ? "% of approved source amount" : `${program.currency} per approved source unit`}; ${source.lines.length} source lines grouped by ${source.grouping?.key ?? "employer"}.`,
      `Dates use the recorded ${policy.dateBasis === "work_date" ? "line work date (document date when none)" : "document date"}; payment is available ${program.paymentDelayDays} days after the earning period closes.`,
      policy.rounding === "per_recipient"
        ? `Recipient shares accumulate exactly across groups and round once to ${minorUnits} currency places per recipient.`
        : `Each group rounds once to ${minorUnits} currency places, then apportions recipient shares.`,
      policy.unassignedShare === "forfeit"
        ? "A share without a program member in its role is forfeited, never redistributed."
        : "Every share needs a program member in its role.",
      budgetCaps
        ? `Ceilings: ${policy.capPercent}% of program items on each ${policy.capProjectTypeId ? "capped-type " : ""}project's original budget, less ${rate}% of all earlier sources; explicit group decisions replace that default and consume recorded awards.`
        : "Existing obligations consume recorded group ceilings.",
    ],
    recipients: result.recipients.map((r) => ({
      employmentId: r.employmentId,
      share: "dated responsibility",
      grossValue:
        uncapped.recipients.find((g) => g.employmentId === r.employmentId)?.value ?? "0.0000",
      value: r.value,
      capped: result.groups.some(
        (g) =>
          g.availableLimit !== null &&
          toUnits(g.awarded) < toUnits(g.potentialAward) &&
          g.recipients.some((x) => x.employmentId === r.employmentId),
      ),
      explanation: `${r.value} ${program.currency} from dated responsibility shares across ${result.groups.filter((g) => g.recipients.some((x) => x.employmentId === r.employmentId)).length} transaction groups.`,
    })),
  };
  const evidence = {
    ...(retainContexts
      ? {
          recipientContexts: selected
            .map((row) => {
              const context = roles.get(row.id);
              if (!context)
                throw new BenefitsError(
                  "REFUSED",
                  "A selected transaction has no retained recipient-source context — reconcile its native source before settlement.",
                );
              return context;
            })
            .sort((a, b) => a.id.localeCompare(b.id)),
        }
      : {}),
    metric: "transactions" as const,
    scope: "company" as const,
    value: measuredValue,
    currency: program.currency,
    entryCount: new Set(source.lines.map((r) => r.documentId)).size,
    lineCount: source.lines.length,
    policy,
    source,
    result,
    priorAwards: prior.evidence,
  };
  const transactionSnapshot = {
    ...evidence,
    digest: createHash("sha256").update(JSON.stringify(evidence)).digest("hex"),
  };
  return {
    measured: {
      metric: "transactions",
      scope: "company",
      sourceAccountIds: [],
      periodFrom,
      periodTo,
      value: measuredValue,
      currency: program.valuation === "percent" ? program.currency : null,
    },
    computation,
    excluded: result.excluded.map((r) => `${r.sourceId}: ${r.reason}`),
    transactionSnapshot,
  };
}
