import { randomUUID } from "node:crypto";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { sql, type SQL } from "drizzle-orm";
import { db, inDbTransaction } from "../platform/db.ts";
import { businessToday, isIsoCalendarDate } from "../platform/business-date.ts";
import {
  postProjectGlEntryWithinTransaction,
  reverseProjectGlEntryWithinTransaction,
} from "../journal/origin-entry.ts";
import { buildNetZeroPairLines } from "./post.ts";
import {
  loadOverheadRuleInEffect,
  overheadApplicationSettings,
  overheadApplicationSettingsFrom,
  syncOverheadSystemRule,
  type OverheadExecutor,
} from "./overhead-sync.ts";
import type { RuleInEffect } from "./types.ts";
import { add, isZero, mul, normalizeMoney } from "../money/money.ts";

/**
 * Overhead posting — the time-approval event of the system-owned
 * 'overhead-net-zero-pair' post rule, and the only writer of overhead
 * journals. When approved time lands on a job, its overhead share
 * (hours × the effective-dated PUBLISHED per-department rate) posts as
 *   DR overhead account [project]   — project-scoped ledger views carry burden
 *   CR overhead account [no tag]    — the account and company P&L net to ZERO
 * in the same moment the standard labor cost does. There is no month-end
 * "apply overhead" chore; the only batch operation is a BACKFILL for hours
 * approved before the mode was enabled (or imported already-approved).
 *
 * The rule itself is derived from the overhead policy and rate card by
 * overhead-sync.ts; this module measures the driver (approved hours priced
 * by the card) and hands the shares to the kernel (buildNetZeroPairLines),
 * which builds the pair and its lineage. Lines carry contributor_kind 'rule'
 * and every carried time entry gets an allocation_lineage row.
 *
 * Each carried entry is stamped with overhead_journal_entry_id, so
 * application is idempotent per entry and reversible per entry — posted
 * history never restates when rates are republished.
 *
 * Deliberately reads the STANDARD published `overhead_rates` (not the live
 * engine): every posting is reproducible from the rate card in force on the
 * worked day.
 */

/**
 * The driver coordinates a rate card resolves against: raw column
 * expressions, never a source table. Any driver with an org, a day, and an
 * (optionally null) department qualifies — approved time today, other
 * event sources tomorrow.
 */
export interface OverheadDriverColumns {
  orgId: SQL;
  workedOn: SQL;
  departmentId: SQL;
}

/**
 * THE overhead-card selection kernel, source-independent: given the rate
 * row's alias and the driver's column expressions, one SQL fragment both
 * the postings below and the statistical measures share, so a reported
 * number can never differ from the pair the ledger carries.
 *
 * It never names a source table — coupling it to time_entries (or any
 * driver table) would fork selection the moment a second source posts.
 * Semantics, unchanged from the time-entry rule it generalizes:
 *   - same org, and the rate's effective window covers the driver's day;
 *   - an org-wide row (null department) applies to every driver — including
 *     department-less ones; a department row only to that department;
 *   - most specific wins: when the driver's department has its own row of
 *     the same rate kind in force that day, org-wide rows of that kind
 *     step aside;
 *   - rows of one scope may stack (category rows) — each match is one term.
 */
export function overheadRateAppliesToDriver(rateAlias: string, driver: OverheadDriverColumns): SQL {
  const r = sql.raw(rateAlias);
  return sql`${r}.org_id = ${driver.orgId}
         and (${r}.department_id is null or ${r}.department_id = ${driver.departmentId})
         and ${r}.effective_from <= ${driver.workedOn}
         and (${r}.effective_to is null or ${r}.effective_to >= ${driver.workedOn})
         and not exists (
           select 1 from overhead_rates specific_rate
            where specific_rate.org_id = ${driver.orgId}
              and specific_rate.rate_kind = ${r}.rate_kind
              and specific_rate.department_id = ${driver.departmentId}
              and ${r}.department_id is null
              and specific_rate.effective_from <= ${driver.workedOn}
              and (specific_rate.effective_to is null or specific_rate.effective_to >= ${driver.workedOn})
         )`;
}

/**
 * The time-entry binding of the kernel above: the same fragment the
 * project-financials measure shares, so a reported number can never differ
 * from the pair the ledger carries.
 */
export function overheadRateAppliesToTimeEntry(rateAlias: string, entryAlias: string): SQL {
  const te = sql.raw(entryAlias);
  return overheadRateAppliesToDriver(rateAlias, {
    orgId: sql`${te}.org_id`,
    workedOn: sql`${te}.worked_on`,
    departmentId: sql`${te}.department_id`,
  });
}

export interface OverheadApplyResult {
  entryId: string | null;
  total: string;
  entries: number;
  projects: number;
  /** Rate-covered entries whose rounded amount was zero, stamped as
   * applied-with-zero (no journal) in this call. */
  dust: number;
}

/**
 * Named dust marker (time_entries.custom): hours × rate rounded to 0.0000.
 * Overhead is statistical — a zero share needs no journal — but the entry
 * must be stamped so the unapplied counter and the backfill stop counting
 * it. overhead_journal_entry_id cannot hold the marker (it is a uuid FK to
 * journal_entries), so the stamp lives in custom, merged (never overwritten).
 * Readers exclude `(custom->>'overheadZeroApplied') = 'true'`.
 */
export const OVERHEAD_ZERO_APPLIED_MARKER = "overheadZeroApplied";

function dustExclusion(entryAlias: string): SQL {
  return sql`(${sql.raw(entryAlias)}.custom->>${OVERHEAD_ZERO_APPLIED_MARKER}) is distinct from 'true'`;
}

async function stampOverheadDust(
  tx: OverheadExecutor,
  orgId: string,
  actorId: string,
  dustIds: string[],
): Promise<void> {
  if (dustIds.length === 0) return;
  await tx.execute(sql`
    update time_entries
       set custom = coalesce(custom, '{}'::jsonb) || '{"overheadZeroApplied": true}'::jsonb,
           updated_at = now(),
           updated_by = ${actorId}
     where org_id = ${orgId}
       and id = any(${`{${dustIds.join(",")}}`}::uuid[])
       and overhead_journal_entry_id is null
       and ${dustExclusion("time_entries")}`);
}

/**
 * Resolve the kernel rule for the posting, provisioning it on first use. The
 * policy read here is advisory — the transaction re-checks under lock — so a
 * mid-flight policy change degrades to the long-standing no-post, never to a
 * mis-stamped one. Null means the policy is not an active pair and no kernel
 * rule is needed (the posting below returns none before touching the rule).
 */
async function ensureOverheadKernelRule(
  orgId: string,
  actorId: string,
  accountId: string | null,
  onDate: string,
): Promise<RuleInEffect | null> {
  if (!accountId) return null;
  let rule = await loadOverheadRuleInEffect(orgId, onDate);
  if (!rule) {
    await syncOverheadSystemRule(orgId, actorId);
    rule = await loadOverheadRuleInEffect(orgId, onDate);
  }
  return rule;
}

/**
 * Apply the overhead pair for a set of approved time entries (the approval
 * hook). Skips silently unless mode is net_zero_pair with an account mapped —
 * callers don't need to pre-check. Only entries that are approved, project-
 * tagged, not yet carried, whose project type doesn't opt out (overhead
 * method 'none'), and whose worked day has a published rate participate.
 */
export async function applyOverheadForTime(orgId: string, actorId: string, timeEntryIds: string[]): Promise<OverheadApplyResult> {
  const none: OverheadApplyResult = { entryId: null, total: "0", entries: 0, projects: 0, dust: 0 };
  if (timeEntryIds.length === 0) return none;
  // Advisory pre-read: provision the kernel rule outside the posting
  // transaction (its sync owns its transactions) when the policy looks
  // active, so the hot path inside stays a pure read.
  const advisory = await overheadApplicationSettings(orgId);
  const advisoryRule = advisory.mode === "net_zero_pair"
    ? await ensureOverheadKernelRule(orgId, actorId, advisory.accountId, await businessToday(orgId))
    : null;
  return inDbTransaction(async (tx) => {
    // Lock the policy row through commit so a configuration change cannot
    // reinterpret half of one source claim.
    const settings = await overheadApplicationSettingsFrom(tx, orgId, true);
    if (!(await lockAndCheckOrgFeature(tx, orgId, "projects"))) return none;
    if (settings.mode !== "net_zero_pair" || !settings.accountId) return none;

    const idArr = `{${timeEntryIds.join(",")}}`;
    // Lock the eligible entries first, then resolve their rate terms: a card
    // may stack several rows for one scope (category rows), so the amount is
    // the SUM of every applicable row's term and each entry appears exactly
    // once — the journal stamp below claims each carried entry once.
    const rows = (await tx.execute<{ id: string; project_id: string; worked_on: string; amount: string }>(sql`
      with locked as (
        select te.id, te.org_id, te.project_id, te.worked_on, te.hours, te.department_id
          from time_entries te
         where te.org_id = ${orgId} and te.id = any(${idArr}::uuid[])
           and te.status = 'approved' and te.project_id is not null
           and te.costing_basis = 'actual'
           and te.overhead_journal_entry_id is null
           and ${dustExclusion("te")}
           and not exists (
             select 1 from projects p
             join project_types pt on pt.id = p.project_type_id and pt.org_id = te.org_id
            where p.id = te.project_id and p.org_id = te.org_id
              and (
                select v.financial_profile->'overhead'->>'method'
                  from project_financial_profile_versions v
                 where v.org_id = te.org_id
                   and v.project_type_id = pt.id
                   and v.effective_from <= te.worked_on
                   and (v.effective_to is null or v.effective_to >= te.worked_on)
                 order by v.effective_from desc
                 limit 1
              ) = 'none'
           )
         order by te.id
         for update of te
      )
      select entry.id, entry.project_id, entry.worked_on,
             -- hours × rate is quantized to the ledger scale at source: the raw
             -- numeric(19,4)×numeric(19,4) product carries up to 8 decimals,
             -- which money parsing would reject as over-precise.
             sum(round(entry.hours * r.rate_percent, 4)) as amount
        from locked entry
        join overhead_rates r
          on r.rate_kind = 'per_hour'
         and ${overheadRateAppliesToDriver("r", {
          orgId: sql`entry.org_id`,
          workedOn: sql`entry.worked_on`,
          departmentId: sql`entry.department_id`,
        })}
       group by entry.id, entry.project_id, entry.worked_on
       order by entry.id`));
    if (rows.rows.length === 0) return none;

    const byProject = new Map<string, string>();
    const entriesByProject = new Map<string, Array<{ id: string; amount: string }>>();
    const carried: string[] = [];
    const dust: string[] = [];
    let total = "0";
    let maxDate = "";
    for (const r of rows.rows) {
      const amt = normalizeMoney(String(r.amount));
      // Hours × rate rounded to 0.0000: no journal leg, but the entry must
      // still be stamped applied-with-zero, or the unapplied counter counts
      // it forever and the backfill breaks on the first all-zero batch.
      if (isZero(amt)) {
        dust.push(r.id);
        continue;
      }
      byProject.set(r.project_id, add(byProject.get(r.project_id) ?? "0", amt));
      const legEntries = entriesByProject.get(r.project_id);
      if (legEntries) legEntries.push({ id: r.id, amount: amt });
      else entriesByProject.set(r.project_id, [{ id: r.id, amount: amt }]);
      total = add(total, amt);
      carried.push(r.id);
      if (r.worked_on > maxDate) maxDate = r.worked_on;
    }
    if (carried.length === 0) {
      if (dust.length > 0) {
        await stampOverheadDust(tx, orgId, actorId, dust);
        return { entryId: null, total: "0", entries: 0, projects: 0, dust: dust.length };
      }
      return none;
    }

    // The kernel owns the pair from here: line-building, contributor
    // stamping and lineage come from the system rule in force on the posting
    // date. The advisory pre-read usually resolved it; a mid-flight policy
    // change falls back to a load (plus one provisioning sync), and a still-
    // missing rule is a fail-closed inconsistency, never an unstamped post.
    const postingDate = maxDate || await businessToday(orgId);
    let kernelRule = advisoryRule;
    if (!kernelRule || kernelRule.version.effectiveFrom > postingDate ||
        (kernelRule.version.effectiveTo != null && kernelRule.version.effectiveTo < postingDate)) {
      kernelRule = await ensureOverheadKernelRule(orgId, actorId, settings.accountId, postingDate);
    }
    if (!kernelRule) {
      throw new Error("overhead kernel rule is not in force for the posting date");
    }
    const kernelAccount = kernelRule.version.accountScope.kind === "accounts"
      ? kernelRule.version.accountScope.accountIds[0] ?? null
      : null;
    if (kernelAccount !== settings.accountId) {
      throw new Error("overhead policy changed during posting; retry the approval");
    }
    const built = buildNetZeroPairLines({
      rule: kernelRule,
      source: { accountId: settings.accountId! },
      total,
      targets: [...byProject].map(([projectId, amt]) => ({
        projectId,
        amount: amt,
        entries: entriesByProject.get(projectId) ?? [],
      })),
    });

    // A released group (reverseOverheadForTime) can be re-applied with the
    // same date and first member, so the entry number must be unique per
    // physical journal under journal_entries_org_number.
    const entryId = await postProjectGlEntryWithinTransaction(tx, {
      orgId,
      actorId,
      origin: "overhead_applied",
      entryNumber: `OVH-${postingDate}-${carried[0]!.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
      postingDate,
      memo: "Overhead applied with approved hours (net-zero pair)",
      lines: built.map((leg) => ({
        accountId: leg.line.accountId,
        amount: leg.line.amount,
        projectId: leg.line.projectId,
        partyId: leg.line.partyId,
        memo: leg.line.memo,
        departmentId: leg.line.departmentId,
        locationId: leg.line.locationId,
        classId: leg.line.classId,
        subsidiaryId: leg.line.subsidiaryId,
        extraDims: leg.line.extraDims,
        contributorKind: leg.line.contributorKind,
        contributorRef: leg.line.contributorRef,
      })),
    });
    if (!entryId) return none;
    const stamped = (await tx.execute<{ id: string }>(sql`
      update time_entries
         set overhead_journal_entry_id = ${entryId},
             updated_at = now(),
             updated_by = ${actorId}
       where org_id = ${orgId}
         and id = any(${`{${carried.join(",")}}`}::uuid[])
         and overhead_journal_entry_id is null
       returning id`));
    if (stamped.rows.length !== carried.length) {
      throw new Error("overhead posting source claim changed before journal stamping");
    }
    // Dust in a mixed batch stamps alongside the carried entries, in the
    // same unit: a crash between the two would strand the backlog again.
    await stampOverheadDust(tx, orgId, actorId, dust);
    // Lineage: one row per carried entry against its project leg (the offset
    // leg is the deterministic mirror — neg(total) of the same rule version —
    // so it carries no row of its own). Legs post in order, so line numbers
    // map 1:1 onto the inserted journal lines.
    const legLineIds = (await tx.execute<{ id: string; line_number: number }>(sql`
      select id, line_number from journal_lines
       where org_id = ${orgId} and entry_id = ${entryId}
       order by line_number`)).rows;
    for (let index = 0; index < built.length - 1; index += 1) {
      const leg = built[index]!;
      const journalLineId = legLineIds[index]?.id;
      if (!journalLineId) throw new Error("overhead journal leg is missing its inserted line");
      for (const draft of leg.lineage) {
        await tx.execute(sql`insert into allocation_lineage
          (id, org_id, mode, rule_id, version_id, definition_hash, run_id, document_id,
           journal_entry_id, journal_line_id, source_journal_line_id, source_document_line_id,
           target_document_line_id, source_time_entry_id, driver_id, driver_value, driver_total,
           share, amount, residual)
          values (${randomUUID()}, ${orgId}, ${draft.mode}, ${draft.ruleId}, ${draft.versionId},
            ${draft.definitionHash}, null, null, ${entryId}, ${journalLineId}, null, null, null,
            ${draft.sourceTimeEntryId}, ${draft.driverId}, ${draft.driverValue}, ${draft.driverTotal},
            ${draft.share}, ${draft.amount}, ${draft.residual ?? "0"})`);
      }
    }
    return { entryId, total, entries: carried.length, projects: byProject.size, dust: dust.length };
  });
}

/* ------------------------------------------------------------------ */
/* Standard overhead selection and measurement                        */
/* ------------------------------------------------------------------ */

/**
 * The driver bases a standard overhead card can price, and the exact
 * overhead_rates kind each one maps to. The mapping is total: every basis
 * names exactly one kind, so a basis can never silently fall back to
 * another kind's card.
 */
export type StandardOverheadBasis = "labor_hours" | "machine_hours" | "units";
export type StandardOverheadRateKind = "per_hour" | "per_machine_hour" | "per_unit";

/** Exact basis → rate-kind mapping: labor_hours→per_hour, machine_hours→per_machine_hour, units→per_unit. */
export function standardOverheadRateKind(basis: StandardOverheadBasis): StandardOverheadRateKind {
  switch (basis) {
    case "labor_hours":
      return "per_hour";
    case "machine_hours":
      return "per_machine_hour";
    case "units":
      return "per_unit";
    default:
      throw new Error(
        `standard overhead basis ${JSON.stringify(basis) ?? "missing"} ` +
          `is not labor_hours, machine_hours, or units; pass the driver's overhead basis`,
      );
  }
}

/**
 * One standard overhead_rates row as resolved for freezing: the exact
 * evidence the release snapshot hashes and the later operation application
 * prices from. Amounts are exact decimal strings at ledger scale.
 */
export interface StandardOverheadCard {
  /** The overhead_rates row (evidence, not a re-query key). */
  id: string;
  orgId: string;
  departmentId: string | null;
  category: string | null;
  method: "standard";
  rateKind: StandardOverheadRateKind;
  ratePercent: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/**
 * Resolve the standard overhead cards covering a driver day — the
 * executor-bound selection kernel behind release freezing. Reads
 * overhead_rates through the passed executor (never ambiently):
 * method='standard', the basis-mapped kind, same org, effective window
 * covering the day, department-specific rows before the org fallback for
 * the mapped kind, category stacks retained. Rows return in a deterministic
 * frozen order (department-specific first, then effective_from, category,
 * row id) so the release snapshot hash is stable. An unknown basis or a
 * malformed date refuses by name; no covering card resolves to an empty
 * set (inert), never to another kind's card.
 */
export async function resolveStandardOverheadCardsInTx(
  executor: OverheadExecutor,
  orgId: string,
  args: { departmentId: string | null; basis: StandardOverheadBasis; onDate: string },
): Promise<StandardOverheadCard[]> {
  if (args.basis !== "labor_hours" && args.basis !== "machine_hours" && args.basis !== "units") {
    throw new Error(
      `standard overhead basis ${JSON.stringify(args.basis) ?? "missing"} ` +
        `is not labor_hours, machine_hours, or units; pass the driver's overhead basis`,
    );
  }
  if (!isIsoCalendarDate(args.onDate)) {
    throw new Error(
      `standard overhead selection date ${JSON.stringify(args.onDate) ?? "missing"} ` +
        `is not a YYYY-MM-DD calendar date; pass the frozen release date`,
    );
  }
  const rateKind = standardOverheadRateKind(args.basis);
  const departmentId = args.departmentId ?? null;
  // A null department binds nothing: `= null` never matches, so only
  // org-wide rows survive — the same department-less rule the live kernel
  // applies, without a null-matching branch.
  const rows = (await executor.execute<{
      id: string;
      department_id: string | null;
      category: string | null;
      rate_percent: string;
      effective_from: string;
      effective_to: string | null;
    }>(sql`
    select id, department_id, category, rate_percent::text as rate_percent,
           effective_from::text as effective_from, effective_to::text as effective_to
      from overhead_rates
     where org_id = ${orgId}
       and rate_kind = ${rateKind}
       and method = 'standard'
       and effective_from <= ${args.onDate}
       and (effective_to is null or effective_to >= ${args.onDate})
       and (department_id is null or department_id = ${departmentId})
     order by case when department_id is null then 1 else 0 end,
              effective_from, category asc nulls first, id asc`)).rows;
  const cards = rows.map((row) => ({
    id: row.id,
    orgId,
    departmentId: row.department_id ?? null,
    category: row.category ?? null,
    method: "standard" as const,
    rateKind,
    ratePercent: String(row.rate_percent),
    effectiveFrom: String(row.effective_from).slice(0, 10),
    effectiveTo: row.effective_to == null ? null : String(row.effective_to).slice(0, 10),
  }));
  // Department-before-org for the mapped kind: when the driver's department
  // has its own standard card covering the day, org-wide cards step aside.
  // Category rows stack: every survivor is one term, in frozen order.
  if (departmentId !== null && cards.some((card) => card.departmentId === departmentId)) {
    return cards.filter((card) => card.departmentId !== null);
  }
  return cards;
}

export interface StandardOverheadTerm {
  cardId: string;
  amount: string;
}

/**
 * Price a driver quantity against frozen standard cards — the pure
 * calculation kernel the later operation application reuses. One exact
 * 4dp halves-away term per stacked card (the same product the postings
 * round in SQL), summed to an exact total. A malformed quantity or card
 * rate refuses naming its source instead of pricing without it.
 */
export function calculateStandardOverheadAmounts(
  cards: readonly StandardOverheadCard[],
  driverQuantity: string,
): { terms: StandardOverheadTerm[]; total: string } {
  let quantity: string;
  try {
    quantity = normalizeMoney(String(driverQuantity));
  } catch {
    throw new Error(
      `standard overhead driver quantity ${JSON.stringify(driverQuantity) ?? "missing"} ` +
        `is not an exact decimal amount; pass the measured driver quantity`,
    );
  }
  const terms: StandardOverheadTerm[] = [];
  let total = "0";
  for (const card of cards) {
    let term: string;
    try {
      term = mul(quantity, String(card.ratePercent));
    } catch {
      throw new Error(
        `frozen standard overhead card ${card.id} has rate ${JSON.stringify(card.ratePercent) ?? "missing"} ` +
          `that is not an exact decimal amount; refreeze the release snapshot`,
      );
    }
    terms.push({ cardId: card.id, amount: term });
    total = add(total, term);
  }
  return { terms, total };
}

/** How many approved project hours aren't carrying overhead yet (for the
 * workspace's backfill affordance). Counts only entries a backfill could
 * actually carry — a published rate must cover the worked day, and dust
 * stamped applied-with-zero is done (it carries no journal by design). */
export async function countUnappliedOverheadTime(orgId: string): Promise<{ entries: number; hours: string }> {
  const r = (await db.execute<{ entries: number; hours: string }>(sql`
    select count(*)::int as entries, coalesce(sum(te.hours), 0) as hours
      from time_entries te
     where te.org_id = ${orgId} and te.status = 'approved' and te.project_id is not null
       and te.costing_basis = 'actual'
       and te.overhead_journal_entry_id is null
       and ${dustExclusion("te")}
       and exists (
         select 1 from overhead_rates r
          where r.rate_kind = 'per_hour' and ${overheadRateAppliesToDriver("r", {
            orgId: sql`te.org_id`,
            workedOn: sql`te.worked_on`,
            departmentId: sql`te.department_id`,
          })}
       )
       and not exists (
         select 1 from projects p
         join project_types pt on pt.id = p.project_type_id and pt.org_id = te.org_id
        where p.id = te.project_id and p.org_id = te.org_id
          and (
            select v.financial_profile->'overhead'->>'method'
              from project_financial_profile_versions v
             where v.org_id = te.org_id
               and v.project_type_id = pt.id
               and v.effective_from <= te.worked_on
               and (v.effective_to is null or v.effective_to >= te.worked_on)
             order by v.effective_from desc
             limit 1
          ) = 'none'
       )`));
  return { entries: Number(r.rows[0]?.entries ?? 0), hours: String(r.rows[0]?.hours ?? "0") };
}

/**
 * Backfill: carry overhead for every eligible approved entry that predates
 * the mode being enabled (or arrived via import). Batched so a decade of
 * history doesn't build one giant journal.
 */
export async function backfillOverhead(orgId: string, actorId: string): Promise<{ entries: number; total: string; journals: number; dust: number }> {
  let entries = 0;
  let total = "0";
  let journals = 0;
  let dust = 0;
  // Loop until no eligible ids remain (each pass stamps what it carries —
  // journals for carried entries, the applied-with-zero marker for dust).
  for (let guard = 0; guard < 200; guard++) {
    const ids = (await db.execute<{ id: string }>(sql`
      select te.id
        from time_entries te
       where te.org_id = ${orgId} and te.status = 'approved' and te.project_id is not null
         and te.costing_basis = 'actual'
         and te.overhead_journal_entry_id is null
         and ${dustExclusion("te")}
         and exists (
           select 1 from overhead_rates r
            where r.rate_kind = 'per_hour' and ${overheadRateAppliesToDriver("r", {
              orgId: sql`te.org_id`,
              workedOn: sql`te.worked_on`,
              departmentId: sql`te.department_id`,
            })}
         )
         and not exists (
           select 1 from projects p
           join project_types pt on pt.id = p.project_type_id and pt.org_id = te.org_id
          where p.id = te.project_id and p.org_id = te.org_id
            and (
              select v.financial_profile->'overhead'->>'method'
                from project_financial_profile_versions v
               where v.org_id = te.org_id
                 and v.project_type_id = pt.id
                 and v.effective_from <= te.worked_on
                 and (v.effective_to is null or v.effective_to >= te.worked_on)
               order by v.effective_from desc
               limit 1
            ) = 'none'
         )
       order by te.worked_on
       limit 2000`));
    if (ids.rows.length === 0) break;
    const res = await applyOverheadForTime(orgId, actorId, ids.rows.map((r) => r.id));
    // An all-dust batch posts no journal but still stamps progress: only
    // stop when a batch neither carries nor stamps, while unstamped rows
    // remain the loop must continue past zero batches.
    if (!res.entryId && res.dust === 0) break;
    entries += res.entries;
    dust += res.dust;
    total = add(total, res.total);
    if (res.entryId) journals++;
  }
  return { entries, total, journals, dust };
}

/** Reverse the overhead pairs carrying these entries (mirror of
 * reverseProjectLaborCost — for unapproval flows). */
export async function reverseOverheadForTime(
  orgId: string,
  actorId: string,
  timeEntryIds: string[],
  reason: string,
  reversalDate?: string,
): Promise<void> {
  if (timeEntryIds.length === 0) return;
  await inDbTransaction(async (tx) => {
    const idArr = `{${timeEntryIds.join(",")}}`;
    const linked = (await tx.execute<{ id: string; overhead_journal_entry_id: string }>(sql`
      select id, overhead_journal_entry_id
        from time_entries
       where org_id = ${orgId}
         and id = any(${idArr}::uuid[])
         and overhead_journal_entry_id is not null
       order by id`));
    const entryIds = [...new Set(linked.rows.map((row) => row.overhead_journal_entry_id))].sort();
    for (const entryId of entryIds) {
      // The journal is the group serialization point. Lock it before updating
      // member rows so disjoint requests for one carried group cannot deadlock.
      const reversal = await reverseProjectGlEntryWithinTransaction(
        tx,
        orgId,
        actorId,
        entryId,
        reason,
        reversalDate,
      );
      if (reversal.status === "missing") {
        throw new Error(`overhead posting journal ${entryId} is missing`);
      }
      // Clear every entry the reversed journal carried; the group is the
      // accounting source unit even when the caller requested one member.
      await tx.execute(sql`
        update time_entries
           set overhead_journal_entry_id = null,
               updated_at = now(),
               updated_by = ${actorId}
         where org_id = ${orgId}
           and overhead_journal_entry_id = ${entryId}`);
    }
  });
}

/** List posted overhead applications (for the workspace history). */
export async function listOverheadApplications(orgId: string, limit = 24) {
  const r = (await db.execute<{ id: string; entry_number: string; posting_date: string; memo: string; status: string; applied_total: string; projects: number }>(sql`
    select e.id, e.entry_number, e.posting_date::text as posting_date, e.memo, e.status,
           (select coalesce(sum(l.amount), 0) from journal_lines l where l.entry_id = e.id and l.org_id = e.org_id and l.project_id is not null) as applied_total,
           (select count(distinct l.project_id) from journal_lines l where l.entry_id = e.id and l.org_id = e.org_id and l.project_id is not null) as projects
      from journal_entries e
     where e.org_id = ${orgId} and e.origin = 'overhead_applied'
     order by e.posting_date desc, e.created_at desc
     limit ${limit}`));
  return r.rows;
}
