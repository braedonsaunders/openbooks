import { sourceTimeAvailableSql } from "./source-time-availability.ts";
import { lockActorIdentity } from "../organization/actor-permissions.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../organization/org-feature-lock.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { add, isZero, mul } from "../money/money.ts";
import { arePeriodModulesOpen } from "../periods/period-policy.ts";
import {
  resolveCoveringPeriodsInWindow,
  type CoveringPeriod,
} from "../periods/period-resolution.ts";
import { laborCostingSettingsInTx } from "./labor-costing.ts";
import { postProjectLaborCost, recognitionAccounts } from "./recognition.ts";

/**
 * Labor cost catch-up. Approval posts labor cost only while posting is on and
 * the control accounts are mapped, so approved time from before that point has
 * no labor cost in the ledger. This module costs that backlog through the same
 * posting path approval uses (postProjectLaborCost), with three additions:
 *
 *   • Only rows the approval path would post are eligible, and only rows whose
 *     covering period is open for GL posting for their legal entity. Rows in a
 *     closed period stay unposted and are reported with their month.
 *   • Every run is refused by name when labor posting is off, the control
 *     accounts are unmapped, or Projects is disabled, and it requires a
 *     reason for the audit trail.
 *   • Posting is idempotent: a stamped row (cost_journal_entry_id) is never
 *     costed again, so a second run posts nothing and writes no audit row.
 */

export const LABOR_COST_CATCH_UP_REASON_MIN_LENGTH = 5;
const LABOR_COST_CATCH_UP_REASON_MAX_LENGTH = 500;
const LABOR_SETUP_HREF = "/admin/setup/labor-costing?view=posting";
const FEATURES_HREF = "/admin/setup/features";

export type LaborCostCatchUpBlockerCode =
  "projects_disabled" | "mode_off" | "accounts_unmapped" | "no_posting_book" | "no_root_subsidiary";

export type LaborCostCatchUpRefusalCode =
  LaborCostCatchUpBlockerCode | "reason_invalid" | "through_invalid" | "scope_restricted";

/** A typed refusal carrying the operator remedy. The API boundary renders
 * code, message and remedy, and the 422 status, without a server-side log. */
export class LaborCostCatchUpRefusal extends Error {
  readonly status = 422;

  constructor(
    readonly code: LaborCostCatchUpRefusalCode,
    message: string,
    readonly remedy: string,
  ) {
    super(message);
    this.name = "LaborCostCatchUpRefusal";
  }
}

export interface LaborCostCatchUpBlocker {
  code: LaborCostCatchUpBlockerCode;
  message: string;
  remedy: string;
  setupHref: string;
}

export interface LaborCostAmount {
  currency: string;
  amount: string;
}

export type LaborCostCatchUpEntryState = "open" | "closed" | "no_period";
export type LaborCostCatchUpMonthState = LaborCostCatchUpEntryState | "partial";

export interface UnpostedLaborMonth {
  /** Calendar month of the approved work, YYYY-MM. */
  month: string;
  entries: number;
  hours: string;
  /** Standard cost per currency; currencies are never summed together. */
  costs: LaborCostAmount[];
  /** open: every entry posts. closed/no_period: none posts. partial: some do. */
  state: LaborCostCatchUpMonthState;
  /** Entries in this month the run will leave unposted. */
  blockedEntries: number;
}

export interface UnpostedLaborTotals {
  entries: number;
  postableEntries: number;
  blockedEntries: number;
  hours: string;
  costs: LaborCostAmount[];
}

export interface UnpostedLaborCostPreview {
  through: string;
  /** Empty when the run would post. A non-empty list means posting is refused. */
  blockers: LaborCostCatchUpBlocker[];
  months: UnpostedLaborMonth[];
  totals: UnpostedLaborTotals;
}

export interface LaborCostCatchUpSkipped {
  month: string;
  state: "closed" | "no_period";
  entries: number;
  remedy: string;
}

export interface LaborCostCatchUpResult {
  through: string;
  postedEntries: number;
  postedHours: string;
  postedCosts: LaborCostAmount[];
  journalEntryIds: string[];
  skippedEntries: number;
  skipped: LaborCostCatchUpSkipped[];
}

/** One eligible approved time entry with its evaluated posting state. */
export interface UnpostedLaborRow {
  id: string;
  hours: string;
  cost: string;
  currency: string;
  month: string;
  state: LaborCostCatchUpEntryState;
}

type CandidateRow = {
  id: string;
  project_id: string;
  hours: string;
  cost_rate: string | null;
  worked_on: string;
  subsidiary_id: string | null;
  cost_rate_currency: string;
};

interface Prerequisites {
  blockers: LaborCostCatchUpBlocker[];
  bookId: string | null;
  rootSubsidiaryId: string | null;
}

function blocker(code: LaborCostCatchUpBlockerCode): LaborCostCatchUpBlocker {
  switch (code) {
    case "projects_disabled":
      return {
        code,
        message: "Projects is off, so project labor cost cannot post.",
        remedy: "Turn on Projects in Company Settings → Features.",
        setupHref: FEATURES_HREF,
      };
    case "mode_off":
      return {
        code,
        message: "Labor costing is not posting standard cost to jobs.",
        remedy:
          "In Labor costing setup → Posting, choose Post standard cost to jobs, then run the catch-up.",
        setupHref: LABOR_SETUP_HREF,
      };
    case "accounts_unmapped":
      return {
        code,
        message: "The labor WIP and labor clearing control accounts are not both mapped.",
        remedy: "In Labor costing setup → Posting, map the labor WIP and labor clearing accounts.",
        setupHref: LABOR_SETUP_HREF,
      };
    case "no_posting_book":
      return {
        code,
        message: "No active primary GL book posts to the ledger.",
        remedy: "Configure one active primary GL book that posts to the ledger.",
        setupHref: LABOR_SETUP_HREF,
      };
    case "no_root_subsidiary":
      return {
        code,
        message: "No active root subsidiary is configured.",
        remedy: "Configure an active root subsidiary at the top of the legal-entity tree.",
        setupHref: LABOR_SETUP_HREF,
      };
  }
}

function refusalFor(blockers: readonly LaborCostCatchUpBlocker[]): LaborCostCatchUpRefusal {
  const first = blockers[0]!;
  const message = blockers.map((item) => item.message).join(" ");
  return new LaborCostCatchUpRefusal(first.code, message, first.remedy);
}

/** Trimmed reason, or a typed refusal. The audit trail needs an explanation. */
export function normalizeCatchUpReason(reason: string): string {
  const trimmed = reason.trim();
  if (trimmed.length < LABOR_COST_CATCH_UP_REASON_MIN_LENGTH) {
    throw new LaborCostCatchUpRefusal(
      "reason_invalid",
      `A reason of at least ${LABOR_COST_CATCH_UP_REASON_MIN_LENGTH} characters is required for the audit trail.`,
      "Describe why this approved time is being costed now.",
    );
  }
  if (trimmed.length > LABOR_COST_CATCH_UP_REASON_MAX_LENGTH) {
    throw new LaborCostCatchUpRefusal(
      "reason_invalid",
      `The reason is longer than ${LABOR_COST_CATCH_UP_REASON_MAX_LENGTH} characters.`,
      "Shorten the reason to a sentence or two.",
    );
  }
  return trimmed;
}

function requireThrough(through: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(through) || !isIsoCalendarDate(through)) {
    throw new LaborCostCatchUpRefusal(
      "through_invalid",
      "The through date must be a calendar date (YYYY-MM-DD).",
      "Choose the last worked-on date to cost, for example 2026-07-31.",
    );
  }
  return through;
}

/** Month state from the states of its entries: one shared state, or partial. */
export function summarizeMonthState(
  states: readonly LaborCostCatchUpEntryState[],
): LaborCostCatchUpMonthState {
  const distinct = new Set(states);
  if (distinct.size === 1) return [...distinct][0]!;
  return "partial";
}

function addCost(costs: Map<string, string>, currency: string, amount: string): void {
  costs.set(currency, add(costs.get(currency) ?? "0", amount));
}

function amountsOf(costs: Map<string, string>): LaborCostAmount[] {
  return [...costs]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([currency, amount]) => ({ currency, amount }));
}

/**
 * Per-month and total figures for eligible rows. Costs stay separated by
 * currency: rows in different currencies have no meaningful sum.
 */
export function summarizeUnpostedRows(rows: readonly UnpostedLaborRow[]): {
  months: UnpostedLaborMonth[];
  totals: UnpostedLaborTotals;
} {
  const byMonth = new Map<string, UnpostedLaborRow[]>();
  for (const row of rows) byMonth.set(row.month, [...(byMonth.get(row.month) ?? []), row]);
  const months = [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, monthRows]): UnpostedLaborMonth => {
      let hours = "0.0000";
      const costs = new Map<string, string>();
      for (const row of monthRows) {
        hours = add(hours, row.hours);
        addCost(costs, row.currency, row.cost);
      }
      return {
        month,
        entries: monthRows.length,
        hours,
        costs: amountsOf(costs),
        state: summarizeMonthState(monthRows.map((row) => row.state)),
        blockedEntries: monthRows.filter((row) => row.state !== "open").length,
      };
    });
  let hours = "0.0000";
  const costs = new Map<string, string>();
  for (const row of rows) {
    hours = add(hours, row.hours);
    addCost(costs, row.currency, row.cost);
  }
  return {
    months,
    totals: {
      entries: rows.length,
      postableEntries: rows.filter((row) => row.state === "open").length,
      blockedEntries: rows.filter((row) => row.state !== "open").length,
      hours,
      costs: amountsOf(costs),
    },
  };
}

/** Feature, mode, control-account, book and root-entity prerequisites. */
async function readPrerequisites(
  executor: SqlExecutor,
  orgId: string,
  lock: boolean,
): Promise<Prerequisites> {
  const blockers: LaborCostCatchUpBlocker[] = [];
  const projectsOn = lock
    ? await lockAndCheckOrgFeature(executor, orgId, "projects")
    : await orgFeatureEnabled(orgId, "projects", executor);
  if (!projectsOn) blockers.push(blocker("projects_disabled"));
  const settings = await laborCostingSettingsInTx(executor, orgId);
  if (settings.mode !== "post") blockers.push(blocker("mode_off"));
  const accounts = await recognitionAccounts(orgId, executor);
  if (!accounts.laborWip || !accounts.laborClearing) blockers.push(blocker("accounts_unmapped"));
  // Same selection the posting kernel makes for an unqualified project journal.
  const book =
    (
      await executor.execute<{ id: string }>(
        sql`
    select id from accounting_books
     where org_id = ${orgId} and is_primary and is_active and posts_gl
     limit 1`,
        "objects",
      )
    )[0] ?? null;
  if (!book) blockers.push(blocker("no_posting_book"));
  const root =
    (
      await executor.execute<{ id: string }>(
        sql`
    select id from subsidiaries
     where org_id = ${orgId} and is_active and not is_elimination and parent_id is null
     limit 1`,
        "objects",
      )
    )[0] ?? null;
  if (!root) blockers.push(blocker("no_root_subsidiary"));
  return { blockers, bookId: book?.id ?? null, rootSubsidiaryId: root?.id ?? null };
}

/**
 * Eligible rows through `through`, each with its posting state. The filter
 * mirrors postProjectLaborCost exactly (approved, project-bound, not internal,
 * costed, unposted), and rows that would cost zero are excluded because the
 * posting path never stamps them. Each row is then checked against the period
 * covering its worked date and the GL gate for its legal entity, the same gate
 * the posting kernel applies to the journal it writes.
 */
async function collectUnpostedRows(
  executor: SqlExecutor,
  orgId: string,
  through: string,
  scope: { bookId: string; rootSubsidiaryId: string },
): Promise<UnpostedLaborRow[]> {
  const candidates = await executor.execute<CandidateRow>(
    sql`
    select te.id, te.project_id, te.hours, te.cost_rate, te.worked_on::text as worked_on,
           coalesce(p.subsidiary_id, te.cost_rate_subsidiary_id) as subsidiary_id,
           coalesce(te.cost_rate_currency, s.base_currency, o.base_currency) as cost_rate_currency
      from time_entries te
      left join projects p on p.id = te.project_id and p.org_id = te.org_id
      left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
      join orgs o on o.id = te.org_id
     where te.org_id = ${orgId}
       and te.status = 'approved' and ${sourceTimeAvailableSql(sql`te.custom`)} and te.project_id is not null
       and te.cost_journal_entry_id is null
       and te.cost_rate is not null
       and te.worked_on <= ${through}::date
       and coalesce(p.is_internal, false) = false
     order by te.worked_on, te.id`,
    "objects",
  );

  const costed = candidates.flatMap((row) => {
    const cost = mul(String(row.hours ?? "0"), String(row.cost_rate ?? "0"));
    return isZero(cost) ? [] : [{ row, cost }];
  });
  if (costed.length === 0) return [];

  const periods: CoveringPeriod[] = await resolveCoveringPeriodsInWindow(
    executor,
    orgId,
    costed[0]!.row.worked_on,
    through,
  );
  const gateCache = new Map<string, boolean>();
  const rows: UnpostedLaborRow[] = [];
  for (const { row, cost } of costed) {
    const period =
      periods.find((item) => item.starts_on <= row.worked_on && row.worked_on <= item.ends_on) ??
      null;
    let state: LaborCostCatchUpEntryState = "no_period";
    if (period) {
      // The posting path posts each journal to the legal entity of its rows,
      // falling back to the root entity when a row has none.
      const subsidiaryId = row.subsidiary_id ?? scope.rootSubsidiaryId;
      const key = `${period.id}|${subsidiaryId}`;
      let open = gateCache.get(key);
      if (open === undefined) {
        open = await arePeriodModulesOpen(executor, {
          orgId,
          periodId: period.id,
          bookId: scope.bookId,
          subsidiaryIds: [subsidiaryId],
          modules: ["gl"],
        });
        gateCache.set(key, open);
      }
      state = open ? "open" : "closed";
    }
    rows.push({
      id: row.id,
      hours: String(row.hours),
      cost,
      currency: row.cost_rate_currency,
      month: row.worked_on.slice(0, 7),
      state,
    });
  }
  return rows;
}

/**
 * What a catch-up through `through` would post and what it would leave, with
 * every refusal that blocks posting. Read-only. Blockers do not hide the rows,
 * so the operator sees both the backlog and the reason it cannot post yet.
 * When the book or root entity is missing, the months are empty, because the
 * gate cannot be evaluated for any row.
 */
export async function previewUnpostedLaborCost(
  orgId: string,
  options: { through: string },
): Promise<UnpostedLaborCostPreview> {
  const through = requireThrough(options.through);
  const prerequisites = await readPrerequisites(db, orgId, false);
  const rows =
    prerequisites.bookId && prerequisites.rootSubsidiaryId
      ? await collectUnpostedRows(db, orgId, through, {
          bookId: prerequisites.bookId,
          rootSubsidiaryId: prerequisites.rootSubsidiaryId,
        })
      : [];
  const { months, totals } = summarizeUnpostedRows(rows);
  return { through, blockers: prerequisites.blockers, months, totals };
}

const SKIP_REMEDY: Record<"closed" | "no_period", string> = {
  closed: "Reopen the period through Close, or leave them.",
  no_period: "Create the accounting period covering these dates in Close, or leave them.",
};

/**
 * Cost approved time through `through` in open periods. Requires posting mode,
 * both control accounts, the Projects feature, gl.post and unrestricted scope,
 * and a reason. The whole run is one transaction with one audit row, so a
 * refusal or failure leaves no partial journal.
 */
export async function postUnpostedLaborCost(
  orgId: string,
  actorId: string,
  options: { through: string; reason: string },
): Promise<LaborCostCatchUpResult> {
  const through = requireThrough(options.through);
  const reason = normalizeCatchUpReason(options.reason);
  return withOrgTransaction(orgId, async () => {
    // Serialize with feature disables, then pin the actor's authority.
    await acquireOrgFeatureGateLock(db, orgId);
    const actor = await lockActorIdentity(db, orgId, actorId);
    if (!actor) throw new ScopeNotFoundError();
    const allowedSubsidiaries = await lockActorCommandAuthority(
      db,
      orgId,
      actorId,
      null,
      "gl.post",
    );
    if (allowedSubsidiaries !== null) {
      throw new LaborCostCatchUpRefusal(
        "scope_restricted",
        "Catch-up posting covers every legal entity, so it needs unrestricted subsidiary access.",
        "Ask an administrator with access to all subsidiaries to run the catch-up.",
      );
    }
    const prerequisites = await readPrerequisites(db, orgId, true);
    if (prerequisites.blockers.length > 0) throw refusalFor(prerequisites.blockers);
    const scope = {
      bookId: prerequisites.bookId!,
      rootSubsidiaryId: prerequisites.rootSubsidiaryId!,
    };

    const rows = await collectUnpostedRows(db, orgId, through, scope);
    const postableIds = rows.filter((row) => row.state === "open").map((row) => row.id);
    const journalEntryIds =
      postableIds.length > 0 ? await postProjectLaborCost(orgId, actorId, postableIds) : [];
    // Read back which rows this run stamped. Only journals created here count,
    // so a concurrent run's stamps never inflate this run's totals.
    const stamped = new Set(
      journalEntryIds.length === 0
        ? []
        : (
            await db.execute<{ id: string }>(
              sql`
      select id from time_entries
       where org_id = ${orgId}
         and cost_journal_entry_id = any(${`{${journalEntryIds.join(",")}}`}::uuid[])`,
              "objects",
            )
          ).map((row) => row.id),
    );
    const posted = rows.filter((row) => stamped.has(row.id));
    const postedSummary = summarizeUnpostedRows(posted).totals;

    const skippedGroups = new Map<string, LaborCostCatchUpSkipped>();
    for (const row of rows) {
      if (row.state === "open" || stamped.has(row.id)) continue;
      const state = row.state === "closed" ? "closed" : "no_period";
      const key = `${row.month}|${state}`;
      const group = skippedGroups.get(key) ?? {
        month: row.month,
        state,
        entries: 0,
        remedy: SKIP_REMEDY[state],
      };
      group.entries += 1;
      skippedGroups.set(key, group);
    }
    const skipped = [...skippedGroups.values()].sort((a, b) =>
      a.month === b.month ? (a.state < b.state ? -1 : 1) : a.month < b.month ? -1 : 1,
    );
    const skippedEntries = skipped.reduce((total, group) => total + group.entries, 0);

    if (posted.length > 0) {
      const eligible = summarizeUnpostedRows(rows).totals;
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'orgs', ${orgId}, 'post', ${JSON.stringify({
          kind: "labor_cost_catch_up",
          reason,
          through,
          before: {
            eligibleEntries: eligible.entries,
            eligibleHours: eligible.hours,
            eligibleCosts: eligible.costs,
          },
          after: {
            postedEntries: posted.length,
            postedHours: postedSummary.hours,
            postedCosts: postedSummary.costs,
            skippedEntries,
          },
          journalEntryIds,
          skipped: skipped.map(({ month, state, entries }) => ({ month, state, entries })),
        })}::jsonb, ${actorId})`);
    }

    return {
      through,
      postedEntries: posted.length,
      postedHours: postedSummary.hours,
      postedCosts: postedSummary.costs,
      journalEntryIds,
      skippedEntries,
      skipped,
    };
  });
}
