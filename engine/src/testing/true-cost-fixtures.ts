import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "./fixtures.ts";

/** Shared scratch-org seeder for True Cost loader tests. Every behaviour keeps its own test; only the scaffolding is shared. */

export const JULY = { from: "2026-07-01", to: "2026-07-31", label: "July 2026" };
export const DAY = "2026-07-14";

export interface TrueCostEmployeeSeed {
  name: string;
  /** Index into the depts array. */
  dept: number;
  hours?: string;
  billable?: boolean;
  rate?: string | null;
  date?: string;
  /** A second entry in the prior window (the no-bill rule spans both windows). */
  priorHours?: string;
  /** Index into the projects array. */
  project?: number;
}

export interface TrueCostJournalLine {
  /** Index into the burdenAccounts array, or "bank" for the offset account. */
  account: number | "bank";
  /** Index into the depts array, null for untagged, omitted for tagged-to-first. */
  dept?: number | null;
  /** Index into the projects array. */
  project?: number | null;
  amount: string;
}

export interface TrueCostOrgSpec {
  depts?: string[];
  employees?: TrueCostEmployeeSeed[];
  projects?: string[];
  /** Each account gets its own burden group (first matching rule wins, so give co-seeded accounts disjoint matches). */
  burdenAccounts?: { number: string; name: string; match?: unknown }[];
  journals?: { entry: string; origin?: string; lines: TrueCostJournalLine[] }[];
  cards?: { dept: number; category: string; rate: string }[];
  wageRates?: { emp: number; currency?: string; rate?: number; basis?: string; annualHours?: number | null }[];
  schedules?: { emp: number; cycleDays?: number; dailyHours?: number[] }[];
  profile?: {
    name?: string;
    compositeMethod?: string;
    baseLaborRate?: string;
    /** Group settings by burden-account index (ids are generated at seed time). */
    categoryGroups?: { group: number; allocationBase?: string; allocationMethod?: string; rateFormat?: string }[];
    /** Base overrides by department index (ids are generated at seed time). */
    baseOverridesByDept?: { squareFeet?: Record<number, number>; units?: Record<number, number>; custom?: Record<number, number> };
  };
  overheadApplication?: { mode: string; account: number };
}

export interface TrueCostSeed {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  deptIds: string[];
  empIds: string[];
  projectIds: string[];
  accountIds: string[];
  groupIds: string[];
}

const BURDEN_MATCH = '{"accountTypes":["expense"],"numberPrefixes":["7"]}' as const;

/** Create a scratch org and seed departments, time, burden accounts, journals, cards, rates and the active profile. */
export async function seedTrueCostOrg(spec: TrueCostOrgSpec): Promise<TrueCostSeed> {
  const org = await withBypass(() => createScratchOrg());
  const deptIds: string[] = [];
  const empIds: string[] = [];
  const projectIds: string[] = [];
  const accountIds: string[] = [];
  const groupIds: string[] = [];
  await withBypass(async () => {
    for (const name of spec.depts ?? ["Field"]) {
      const id = randomUUID();
      deptIds.push(id);
      await db.execute(sql`insert into departments (id, org_id, name, is_active, custom)
        values (${id}, ${org.orgId}, ${name}, true, '{}'::jsonb)`);
    }
    for (const code of spec.projects ?? []) {
      const id = randomUUID();
      projectIds.push(id);
      await db.execute(sql`insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
        values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${code}, ${code}, ${org.customerId}, 'active', true, '{}'::jsonb)`);
    }
    for (const e of spec.employees ?? []) {
      const id = randomUUID();
      empIds.push(id);
      await db.execute(sql`insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
        values (${id}, ${org.orgId}, 'employee', ${e.name}, ${org.subsidiaryId}, true, '{}'::jsonb)`);
      await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, project_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
        values (${randomUUID()}, ${org.orgId}, ${id}, ${e.date ?? DAY}, ${e.hours ?? "8.0000"}, 'approved', ${e.billable ?? true}, ${deptIds[e.dept]!}, ${e.project == null ? null : projectIds[e.project]!}, ${e.rate ?? null}, ${e.rate == null ? null : "CAD"}, null, '{}'::jsonb)`);
      if (e.priorHours != null) {
        await db.execute(sql`insert into time_entries (id, org_id, employee_party_id, worked_on, hours, status, is_billable, department_id, project_id, cost_rate, cost_rate_currency, cost_rate_subsidiary_id, custom)
          values (${randomUUID()}, ${org.orgId}, ${id}, '2026-06-10', ${e.priorHours}, 'approved', ${e.billable ?? true}, ${deptIds[e.dept]!}, null, ${e.rate ?? null}, ${e.rate == null ? null : "CAD"}, null, '{}'::jsonb)`);
      }
    }
    for (const a of spec.burdenAccounts ?? []) {
      const accountId = randomUUID();
      const groupId = randomUUID();
      accountIds.push(accountId);
      groupIds.push(groupId);
      await db.execute(sql`insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${accountId}, ${org.orgId}, ${a.number}, ${a.name}, 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
      // Group key derives from the account name so tests address categories by a stable key.
      const key = a.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      await db.execute(sql`insert into account_groups (id, org_id, dimension, key, name, match, is_catch_all, is_active)
        values (${groupId}, ${org.orgId}, 'burden', ${key}, ${a.name}, ${JSON.stringify(a.match ?? JSON.parse(BURDEN_MATCH))}::jsonb, false, true)`);
    }
    for (const j of spec.journals ?? []) {
      const entry = randomUUID();
      const lines = j.lines.map((l, i) => ({
        n: i + 1,
        account: l.account === "bank" ? org.accounts.bank : accountIds[l.account]!,
        dept: l.dept === undefined ? deptIds[0]! : l.dept == null ? null : deptIds[l.dept]!,
        project: l.project == null ? null : projectIds[l.project]!,
        amount: l.amount,
      }));
      await db.execute(sql`insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
        values (${entry}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${j.entry}, ${DAY}, ${org.periodId}, 'draft', ${j.origin ?? "manual"})`);
      for (const l of lines) {
        await db.execute(sql`insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, department_id, project_id, amount, currency, txn_amount, fx_rate)
          values (${org.orgId}, ${entry}, ${l.n}, ${l.account}, ${org.subsidiaryId}, ${l.dept}, ${l.project}, ${l.amount}, 'CAD', ${l.amount}, '1')`);
      }
      await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entry}`);
    }
    for (const c of spec.cards ?? []) {
      await db.execute(sql`insert into overhead_rates (id, org_id, department_id, category, method, rate_kind, rate_percent, effective_from)
        values (${randomUUID()}, ${org.orgId}, ${deptIds[c.dept]!}, ${c.category}, 'standard', 'per_hour', ${c.rate}, '2026-01-01')`);
    }
    for (const w of spec.wageRates ?? []) {
      await db.execute(sql`insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours, effective_from)
        values (${org.orgId}, ${empIds[w.emp]!}, ${w.currency ?? "CAD"}, ${w.rate ?? 80000}, ${w.basis ?? "year"}, ${w.annualHours ?? 2000}, '2026-01-01')`);
    }
    for (const s of spec.schedules ?? []) {
      const scheduleId = randomUUID();
      await db.execute(sql`insert into work_schedules (id, org_id, name, employee_party_id, pattern, cycle_days, cycle_anchor, effective_from, is_active, created_by, updated_by)
        values (${scheduleId}, ${org.orgId}, 'Seed schedule', ${empIds[s.emp]!}, 'cycle', ${s.cycleDays ?? 7}, '2026-01-04', '2026-01-01', true, null, null)`);
      for (const [day, hours] of (s.dailyHours ?? [8, 8, 8, 8, 8]).entries()) {
        await db.execute(sql`insert into work_schedule_days (org_id, schedule_id, day_index, hours, created_by, updated_by)
          values (${org.orgId}, ${scheduleId}, ${day + 1}, ${String(hours)}, null, null)`);
      }
    }
    if (spec.overheadApplication) {
      await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ overheadApplication: { mode: spec.overheadApplication.mode, accountId: accountIds[spec.overheadApplication.account]! } })}::jsonb
        where id = ${org.orgId}`);
    }
    const p = spec.profile ?? {};
    const categorySettings: Record<string, unknown> = {};
    for (const g of p.categoryGroups ?? []) categorySettings[groupIds[g.group]!] = { ...g, group: undefined };
    const baseOverrides: Record<string, Record<string, number>> = {};
    for (const [kind, values] of Object.entries(p.baseOverridesByDept ?? {})) {
      baseOverrides[kind] = Object.fromEntries(
        Object.entries(values as Record<string, number>).map(([index, value]) => [deptIds[Number(index)]!, value]),
      );
    }
    await db.execute(sql`update orgs set settings = settings || ${JSON.stringify({ analytics: { trueCost: { activeProfileId: "p1", profiles: [{ id: "p1", name: p.name ?? "Seed", color: null, compositeMethod: p.compositeMethod ?? "sum", baseLaborRate: "", categorySettings, customCategories: [], baseOverrides }] } } })}::jsonb
      where id = ${org.orgId}`);
  });
  return { org, deptIds, empIds, projectIds, accountIds, groupIds };
}

/** Seed an org, run the assertions inside its org context, then drop the org. */
export async function withTrueCostOrg(spec: TrueCostOrgSpec, fn: (seed: TrueCostSeed) => Promise<void>): Promise<void> {
  const seed = await seedTrueCostOrg(spec);
  try {
    await withOrgContext(seed.org.orgId, () => fn(seed));
  } finally {
    await withBypass(() => dropScratchOrg(seed.org.orgId));
  }
}
