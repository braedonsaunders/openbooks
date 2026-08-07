import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, neg, sum } from "./money.ts";
import { hasUsablePayRateSql } from "./payroll-rate.ts";
import { payrollSettings } from "./payroll-run.ts";
import { packSlotState } from "./payroll/packs.ts";

/**
 * Pre-flight for a pay run: what must be fixed before it can calculate, what
 * the operator should look at before committing, what the payday actually
 * costs to fund, and what changed for each employee since their last pay.
 *
 * Blocker vs warning is a hard line. A blocker means the run cannot produce a
 * correct stub or a balanced posting (missing wage, unmapped statutory
 * account, closed period). Everything else is advisory — payroll teams
 * legitimately pay someone with zero hours, or run a period twice, and the
 * product's job is to make them see it, not to refuse.
 */

export type ReadinessSeverity = "blocker" | "warning";

export interface ReadinessItem {
  severity: ReadinessSeverity;
  /** Stable code; the UI localizes it and links to the fix. */
  code: string;
  /** Employees the item concerns (empty = a run/org-level item). */
  employees: { partyId: string; name: string }[];
  /** Substitution for the message (slot key, period name, …). */
  detail?: string;
  /** Where the operator resolves it, when there is one obvious place. */
  href?: string;
}

export interface PayRunReadiness {
  items: ReadinessItem[];
  blockers: number;
  warnings: number;
  /** Employees in scope after exclusions — the run's actual population. */
  included: number;
}

interface ScopeRow {
  employee_party_id: string;
  name: string;
  pay_basis: string;
  country: string;
  has_wage: boolean;
  approved_hours: string;
  terminated_on: string | null;
  paid_in_period: boolean;
  has_bank: boolean;
  has_sin: boolean;
}

interface RunRow {
  pay_schedule_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  run_type: string;
  run_status: string;
  subsidiary_id: string | null;
}

async function runContext(orgId: string, documentId: string): Promise<RunRow | null> {
  const runs = (await db.execute(sql`
    select r.pay_schedule_id, r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.run_type, r.run_status, s.subsidiary_id
      from pay_runs r
      join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `)) as unknown as { rows: RunRow[] };
  return runs.rows[0] ?? null;
}

/**
 * Everyone the run will pay, with the facts each check needs.
 *
 * The population predicates are the RUN's, not readiness's own: a
 * subsidiary-scoped pay schedule pays only that entity's employees, and an
 * employee terminated before the period started is not paid at all
 * (calculatePayRun applies both). Describing a different population from the
 * one that will be paid makes every per-employee count on this screen wrong.
 */
async function scope(orgId: string, documentId: string, run: RunRow): Promise<ScopeRow[]> {
  const rows = (await db.execute(sql`
    select p.id as employee_party_id, p.display_name as name, prof.pay_basis, prof.country,
           coalesce(te.hours, 0)::text as approved_hours,
           er.terminated_on::text as terminated_on,
           prof.sin_encrypted is not null as has_sin,
           exists (
             select 1 from party_bank_accounts b
              where b.org_id = prof.org_id and b.party_id = p.id
                and b.is_active and b.approval_status = 'approved') as has_bank,
           coalesce(${hasUsablePayRateSql({
             org: sql`prof.org_id`,
             employee: sql`prof.employee_party_id`,
             onDate: run.period_end,
             payBasis: sql`prof.pay_basis`,
           })}, false) as has_wage,
           exists (
             select 1 from pay_stubs s2
               join pay_runs r2 on r2.document_id = s2.pay_run_document_id
              where s2.org_id = prof.org_id and s2.employee_party_id = prof.employee_party_id
                and s2.pay_run_document_id <> ${documentId}
                and r2.run_status = 'committed'
                and r2.period_start <= ${run.period_end}
                and r2.period_end >= ${run.period_start}) as paid_in_period
      from employee_payroll_profiles prof
      join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
      left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id
      left join lateral (
        select sum(t.hours) as hours from time_entries t
         where t.org_id = prof.org_id and t.employee_party_id = prof.employee_party_id
           and t.status = 'approved'
           and t.worked_on between ${run.period_start} and ${run.period_end}) te on true
     where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id} and prof.is_active
       -- calculatePayRun's own two population predicates, verbatim.
       and (er.terminated_on is null or er.terminated_on >= ${run.period_start})
       and (${run.subsidiary_id}::uuid is null or p.subsidiary_id = ${run.subsidiary_id}::uuid)
       and not exists (
         select 1 from pay_run_adjustments a
          where a.org_id = ${orgId} and a.pay_run_document_id = ${documentId}
            and a.adjustment_type = 'exclude' and a.employee_party_id = p.id)
     order by p.display_name
  `)) as unknown as { rows: ScopeRow[] };
  return rows.rows;
}

export async function payRunReadiness(orgId: string, documentId: string): Promise<PayRunReadiness> {
  const items: ReadinessItem[] = [];
  const flag = (
    severity: ReadinessSeverity,
    code: string,
    employees: ScopeRow[] = [],
    extra: { detail?: string; href?: string } = {},
  ) => {
    items.push({
      severity, code,
      employees: employees.map((e) => ({ partyId: e.employee_party_id, name: e.name })),
      ...extra,
    });
  };
  const tally = (included: number): PayRunReadiness => ({
    items,
    blockers: items.filter((i) => i.severity === "blocker").length,
    warnings: items.filter((i) => i.severity === "warning").length,
    included,
  });

  const run = await runContext(orgId, documentId);
  if (!run) return tally(0);
  const people = await scope(orgId, documentId, run);

  // --- Org configuration: a commit cannot balance without these ------------
  const setupHref = "/admin/setup/payroll";
  const settings = await payrollSettings(orgId);
  if (!settings.wageExpenseAccountId) flag("blocker", "setup.wageExpense", [], { href: setupHref });
  if (!settings.netPayAccountId) flag("blocker", "setup.netPay", [], { href: setupHref });
  if (settings.wagesTo === "labor_clearing") {
    const clearing = (await db.execute(sql`
      select settings#>>'{laborCosting,clearingAccountId}' as id from orgs where id = ${orgId}
    `)) as unknown as { rows: { id: string | null }[] };
    if (!clearing.rows[0]?.id) flag("blocker", "setup.laborClearing", [], { href: setupHref });
  }

  // Every statutory slot of every pack the run's people belong to must resolve
  // to a liability account, or the commit has nowhere to credit withholdings.
  const blob = (await db.execute(sql`
    select settings->'payroll' as p from orgs where id = ${orgId}
  `)) as unknown as { rows: { p: Record<string, unknown> | null }[] };
  const legacy = blob.rows[0]?.p ?? {};
  const installed = Array.isArray((legacy as { countries?: unknown }).countries)
    ? ((legacy as { countries: unknown[] }).countries).map(String)
    : ["CA"];
  const countriesInRun = new Set(people.map((p) => p.country));
  for (const pack of await packSlotState(orgId, installed, legacy)) {
    if (people.length > 0 && !countriesInRun.has(pack.country)) continue;
    for (const slot of pack.slots) {
      if (!slot.accountId) {
        flag("blocker", "setup.slot", [], {
          detail: `${pack.country} · ${slot.key}`,
          href: `${setupHref}?tab=${pack.country.toLowerCase()}`,
        });
      }
    }
  }

  // --- Period control: posting into a closed period fails at post ---------
  const lock = (await db.execute(sql`
    select p.name, coalesce(l.state, 'open') as state
      from accounting_periods p
      join accounting_books b on b.org_id = p.org_id and b.is_primary and b.is_active
      left join period_locks l
        on l.org_id = p.org_id and l.period_id = p.id and l.book_id = b.id and l.module = 'gl'
       and (l.subsidiary_id is not distinct from ${run.subsidiary_id} or l.subsidiary_id is null)
     where p.org_id = ${orgId} and p.starts_on <= ${run.pay_date} and p.ends_on >= ${run.pay_date}
       and p.is_adjustment = false
     order by (l.subsidiary_id is not null) desc
     limit 1
  `)) as unknown as { rows: { name: string; state: string }[] };
  if (!lock.rows[0]) flag("blocker", "period.missing", [], { detail: run.pay_date });
  else if (lock.rows[0].state !== "open") {
    flag("blocker", "period.closed", [], { detail: lock.rows[0].name, href: "/admin/close" });
  }

  // --- Population ---------------------------------------------------------
  if (people.length === 0) flag("blocker", "scope.empty", []);

  const employeesHref = "/entities/employees";
  const noWage = people.filter((p) => !p.has_wage);
  if (noWage.length) flag("blocker", "employee.noWage", noWage, { href: employeesHref });

  const zeroHours = people.filter((p) => p.pay_basis === "hourly" && Number(p.approved_hours) === 0);
  if (zeroHours.length) flag("warning", "employee.zeroHours", zeroHours, { href: "/timesheets" });

  const paidTwice = people.filter((p) => p.paid_in_period);
  if (paidTwice.length) flag("warning", "employee.paidInPeriod", paidTwice);

  // A final pay belongs on a termination run: flag terminated people elsewhere.
  const terminated = people.filter((p) => p.terminated_on && p.terminated_on <= run.period_end);
  if (run.run_type !== "termination" && terminated.length) {
    flag("warning", "employee.terminated", terminated);
  }

  const noBank = people.filter((p) => !p.has_bank);
  if (noBank.length) flag("warning", "employee.noBankDetails", noBank, { href: employeesHref });

  const noSin = people.filter((p) => !p.has_sin);
  if (noSin.length) flag("warning", "employee.noSin", noSin, { href: employeesHref });

  return tally(people.length);
}

export interface PayRunStaleness {
  /** True when an input changed after the run was last calculated. */
  stale: boolean;
  /** Stable codes for what changed — see STALENESS_INPUT_CLASSES. */
  reasons: string[];
  calculatedAt: string | null;
}

/**
 * Every class of input a calculated stub is a function of. The wizard blocks
 * the commit while any of them changed after `calculated_at`, so anything
 * MISSING from this list is a silent commit of figures the operator edited
 * past — which is the one failure this control exists to prevent.
 *
 * `missing` is the run row itself: a run that cannot be read is not a fresh
 * run, and reporting it fresh green-lights a commit against nothing.
 */
export const STALENESS_INPUT_CLASSES = [
  "missing",
  "adjustments",
  "time",
  "wages",
  "roster",
  "components",
  "componentDefinitions",
  "derivedRules",
  "entitlements",
  "settings",
  "ytd",
] as const;

/**
 * Whether the calculated stubs still reflect the run's inputs. Payroll's worst
 * failure mode is committing figures the operator edited past — so the wizard
 * reads this on every render and blocks the commit while it is stale, rather
 * than trusting anyone to remember to recalculate.
 *
 * KNOWN GAP: `worker_comp_groups` carries no audit columns, so a change to a
 * WCB/WSIB class RATE cannot be detected here (a change of an employee's
 * ASSIGNED class is caught through `employee_roles`). See
 * .local/handoff-controls.md — the table needs `...auditColumns`.
 */
export async function payRunStaleness(
  orgId: string,
  documentId: string,
): Promise<PayRunStaleness> {
  const rows = (await db.execute(sql`
    select r.calculated_at,
           r.calculated_at is null as never_calculated,
           exists (
             select 1 from pay_run_adjustments a
              where a.org_id = r.org_id and a.pay_run_document_id = r.document_id
                and a.updated_at > r.calculated_at) as adjustments_changed,
           exists (
             select 1 from time_entries t
              where t.org_id = r.org_id and t.status = 'approved'
                and t.worked_on between r.period_start and r.period_end
                and t.updated_at > r.calculated_at) as time_changed,
           exists (
             select 1 from labor_cost_rates w
              where w.org_id = r.org_id and w.updated_at > r.calculated_at) as wages_changed,
           -- Roster: the payroll profile (TD1/W-4, exemptions, schedule) and
           -- the employment record the run reads for termination, job title,
           -- trade and WCB class.
           exists (
             select 1 from employee_payroll_profiles prof
              where prof.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
                and prof.updated_at > r.calculated_at) as roster_changed,
           exists (
             select 1 from employee_roles er
              join employee_payroll_profiles prof
                on prof.org_id = er.org_id and prof.employee_party_id = er.party_id
              where er.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
                and er.updated_at > r.calculated_at) as employment_changed,
           -- Per-employee assigned components: garnishments, benefits, RRSP,
           -- union dues overrides. Editing one of these changes net pay.
           exists (
             select 1 from employee_pay_components epc
              join employee_payroll_profiles prof
                on prof.org_id = epc.org_id and prof.employee_party_id = epc.employee_party_id
              where epc.org_id = r.org_id and prof.pay_schedule_id = r.pay_schedule_id
                and epc.updated_at > r.calculated_at) as components_changed,
           -- The component DEFINITIONS themselves (rate, taxability,
           -- pensionable/insurable flags, liability account).
           exists (
             select 1 from pay_components c
              where c.org_id = r.org_id and c.updated_at > r.calculated_at)
             as component_definitions_changed,
           exists (
             select 1 from pay_derived_rules dr
              where dr.org_id = r.org_id and dr.updated_at > r.calculated_at)
             as derived_rules_changed,
           -- Entitlement plans, their limits and their service tiers: all
           -- three move accrual and payout amounts on the stub.
           (exists (select 1 from entitlement_plans ep
                     where ep.org_id = r.org_id and ep.updated_at > r.calculated_at)
            or exists (select 1 from entitlement_plan_limits el
                        where el.org_id = r.org_id and el.updated_at > r.calculated_at)
            or exists (select 1 from entitlement_service_tiers et
                        where et.org_id = r.org_id and et.updated_at > r.calculated_at))
             as entitlements_changed,
           -- Org payroll settings: EHT/SUI rates, exemptions, posting accounts,
           -- and the filing accounts a remittance is grouped under.
           --
           -- orgs.updated_at is watched but is NOT sufficient on its own: the
           -- settings writers update orgs.settings without stamping
           -- updated_at, and there is no trigger. The audit_log row
           -- those writers DO insert ('orgs' / the org id) is the reliable
           -- signal today. See .local/handoff-controls.md for the touch
           -- trigger that would make the column authoritative.
           (exists (select 1 from orgs o
                     where o.id = r.org_id and o.updated_at > r.calculated_at)
            or exists (select 1 from audit_log al
                        where al.org_id = r.org_id and al.table_name = 'orgs'
                          and al.at > r.calculated_at)
            or exists (select 1 from payroll_filing_accounts fa
                        where fa.org_id = r.org_id and fa.updated_at > r.calculated_at))
             as settings_changed,
           -- Another run consumed this employee's statutory room. A run
           -- calculated before an off-cycle run commits carries the YTD the
           -- off-cycle run has already used, and over-deducts the employee past
           -- the CPP/EI maximum (or under-deducts if that run was voided).
           exists (
             select 1 from pay_runs other
              where other.org_id = r.org_id and other.document_id <> r.document_id
                and other.tax_year = r.tax_year
                and other.run_status in ('committed', 'voided')
                and other.updated_at > r.calculated_at
                and exists (
                  select 1 from pay_stubs os
                    join pay_stubs mine
                      on mine.employee_party_id = os.employee_party_id
                     and mine.pay_run_document_id = r.document_id
                   where os.pay_run_document_id = other.document_id)) as ytd_changed
      from pay_runs r
     where r.org_id = ${orgId} and r.document_id = ${documentId}
  `)) as unknown as {
    rows: {
      calculated_at: Date | string | null; never_calculated: boolean;
      adjustments_changed: boolean; time_changed: boolean;
      wages_changed: boolean; roster_changed: boolean; employment_changed: boolean;
      components_changed: boolean; component_definitions_changed: boolean;
      derived_rules_changed: boolean; entitlements_changed: boolean;
      settings_changed: boolean; ytd_changed: boolean;
    }[];
  };
  const row = rows.rows[0];
  // A missing run is not a fresh run. Fail closed and say why.
  if (!row) return { stale: true, reasons: ["missing"], calculatedAt: null };
  if (row.never_calculated) return { stale: false, reasons: [], calculatedAt: null };
  const reasons = [
    row.adjustments_changed ? "adjustments" : null,
    row.time_changed ? "time" : null,
    row.wages_changed ? "wages" : null,
    row.roster_changed || row.employment_changed ? "roster" : null,
    row.components_changed ? "components" : null,
    row.component_definitions_changed ? "componentDefinitions" : null,
    row.derived_rules_changed ? "derivedRules" : null,
    row.entitlements_changed ? "entitlements" : null,
    row.settings_changed ? "settings" : null,
    row.ytd_changed ? "ytd" : null,
  ].filter((r): r is string => r !== null);
  return {
    stale: reasons.length > 0,
    reasons,
    calculatedAt: row.calculated_at instanceof Date
      ? row.calculated_at.toISOString()
      : (row.calculated_at ?? null),
  };
}

export interface PayRunFunding {
  /** Net pay owed to employees — the money that must leave the bank. */
  netPay: string;
  /** Statutory + benefit liabilities the run records (remitted later). */
  liabilities: string;
  /** Total employer cost of the payday. */
  totalCost: string;
  payDate: string;
  /** Business days from today to the pay date (negative = already past). */
  businessDaysToPayDate: number;
  /** Bank accounts with book balance, for the funding picker. */
  accounts: { id: string; label: string; balance: string; sufficient: boolean }[];
}

function businessDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const forward = to >= from;
  const cursor = new Date(forward ? from : to);
  const end = forward ? to : from;
  let days = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days++;
  }
  return forward ? days : -days;
}

/** What this payday costs, and whether the chosen bank can carry it. */
export async function payRunFunding(orgId: string, documentId: string): Promise<PayRunFunding> {
  const run = await runContext(orgId, documentId);
  const payDate = run?.pay_date ?? new Date().toISOString().slice(0, 10);

  const totals = (await db.execute(sql`
    select coalesce(sum(net_pay), 0)::text as net,
           coalesce(sum(gross), 0)::text as gross,
           coalesce(sum(employer_cost), 0)::text as employer
      from pay_stubs where org_id = ${orgId} and pay_run_document_id = ${documentId}
  `)) as unknown as { rows: { net: string; gross: string; employer: string }[] };
  const t = totals.rows[0] ?? { net: "0", gross: "0", employer: "0" };
  // Liabilities = what the run owes but does not pay today: employee
  // withholdings (gross − net) plus the employer-side accruals.
  const liabilities = add(add(t.gross, neg(t.net)), t.employer);

  const accounts = (await db.execute(sql`
    select a.id, coalesce(a.number || ' · ', '') || a.name as label,
           coalesce(bal.amount, 0)::text as balance
      from accounts a
      left join lateral (
        select sum(jl.amount) as amount
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.status = 'posted'
         where jl.org_id = a.org_id and jl.account_id = a.id) bal on true
     where a.org_id = ${orgId} and a.is_active and not a.is_summary and a.type = 'asset_bank'
     order by a.number nulls last, a.name
  `)) as unknown as { rows: { id: string; label: string; balance: string }[] };

  return {
    netPay: t.net,
    liabilities,
    totalCost: add(t.net, liabilities),
    payDate,
    businessDaysToPayDate: businessDaysBetween(new Date().toISOString().slice(0, 10), payDate),
    accounts: accounts.rows.map((a) => ({ ...a, sufficient: cmp(a.balance, t.net) >= 0 })),
  };
}

export interface StubChange {
  employeePartyId: string;
  employeeName: string;
  /** Pay date of the previous committed stub, when there is one. */
  previousPayDate: string | null;
  netDelta: string;
  grossDelta: string;
  hoursDelta: string;
  /** Component-level differences: added, removed, or changed amount. */
  changes: {
    kind: "added" | "removed" | "changed";
    component: string;
    from: string | null;
    to: string | null;
  }[];
}

/**
 * What changed for each employee since their previous committed stub.
 * Payroll review is a diff exercise — reconstructing it by eye is exactly
 * where errors survive — so compare the component sets, not just net pay.
 */
export async function payRunChanges(orgId: string, documentId: string): Promise<StubChange[]> {
  const rows = (await db.execute(sql`
    with current_stub as (
      select s.id, s.employee_party_id, p.display_name as name, s.gross, s.net_pay
        from pay_stubs s
        join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    ),
    previous_stub as (
      select distinct on (s.employee_party_id)
             s.employee_party_id, s.id, s.gross, s.net_pay, s.pay_date::text as pay_date
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.run_status = 'committed'
       where s.org_id = ${orgId} and s.pay_run_document_id <> ${documentId}
       order by s.employee_party_id, s.pay_date desc, s.id desc
    )
    select c.employee_party_id, c.name, c.gross, c.net_pay,
           pv.gross as prev_gross, pv.net_pay as prev_net, pv.pay_date as prev_pay_date,
           coalesce((select json_agg(json_build_object('d', l.description, 'a', l.amount, 'h', l.hours))
                       from pay_stub_lines l where l.stub_id = c.id), '[]'::json) as current_lines,
           coalesce((select json_agg(json_build_object('d', l.description, 'a', l.amount, 'h', l.hours))
                       from pay_stub_lines l where l.stub_id = pv.id), '[]'::json) as previous_lines
      from current_stub c
      left join previous_stub pv on pv.employee_party_id = c.employee_party_id
     order by c.name
  `)) as unknown as {
    rows: {
      employee_party_id: string; name: string; gross: string; net_pay: string;
      prev_gross: string | null; prev_net: string | null; prev_pay_date: string | null;
      current_lines: { d: string; a: string; h: string | null }[] | null;
      previous_lines: { d: string; a: string; h: string | null }[] | null;
    }[];
  };

  const fold = (lines: { d: string; a: string; h: string | null }[] | null) => {
    const map = new Map<string, { amount: string; hours: string }>();
    for (const line of lines ?? []) {
      const seen = map.get(line.d) ?? { amount: "0", hours: "0" };
      map.set(line.d, {
        amount: add(seen.amount, line.a),
        hours: add(seen.hours, line.h ?? "0"),
      });
    }
    return map;
  };

  return rows.rows.map((row) => {
    const now = fold(row.current_lines);
    const before = fold(row.previous_lines);
    const changes: StubChange["changes"] = [];
    for (const [component, value] of now) {
      const prior = before.get(component);
      if (!prior) changes.push({ kind: "added", component, from: null, to: value.amount });
      else if (cmp(prior.amount, value.amount) !== 0) {
        changes.push({ kind: "changed", component, from: prior.amount, to: value.amount });
      }
    }
    for (const [component, value] of before) {
      if (!now.has(component)) {
        changes.push({ kind: "removed", component, from: value.amount, to: null });
      }
    }
    return {
      employeePartyId: row.employee_party_id,
      employeeName: row.name,
      previousPayDate: row.prev_pay_date,
      netDelta: add(row.net_pay, neg(row.prev_net ?? "0")),
      grossDelta: add(row.gross, neg(row.prev_gross ?? "0")),
      hoursDelta: add(
        sum([...now.values()].map((v) => v.hours)),
        neg(sum([...before.values()].map((v) => v.hours))),
      ),
      changes,
    };
  });
}
