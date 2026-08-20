import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../../db.ts";
import { provisionOrganizationDefaults } from "../../organization-provisioning.ts";
import { SIM_ORG_PREFIX } from "../../sim/db-guard.ts";
import type { SimOrg, SimPeriod } from "../../sim/world.ts";
import type { Corpus, CorpusParty, CorpusProject } from "./types.ts";

/**
 * Provision a minimal, disposable org for corpus replay. Mirrors the verified
 * column layout of engine/src/sim/world.ts provisionOrg, but parameterized by
 * the corpus itself: exactly the accounts, parties, and (optionally) projects
 * the corpus declares — no opening balances, no seeded population. The org is
 * sim-tagged (settings.simHarness + "SIM · " name prefix) so the guarded
 * teardown path (sim/world.ts resetOrg) applies to it and a wrong id can never
 * touch a real tenant.
 *
 * Returns a SimOrg-shaped world so the sim's proven activity primitives
 * (createDraftDocument / postDraftDocument / payment ops) drive the replay —
 * every figure flows through the real posting kernel.
 */

export interface CorpusWorld {
  world: SimOrg;
  /** Semantic party key → party id. */
  partyIds: Record<string, string>;
  /** Semantic project key → project id (when the corpus declares projects). */
  projectIds: Record<string, string>;
}

function lastDayOfMonth(year: number, month: number): string {
  const day = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function monthsInWindow(startDate: string, endDate: string): { year: number; month: number }[] {
  const out: { year: number; month: number }[] = [];
  let y = Number(startDate.slice(0, 4));
  let m = Number(startDate.slice(5, 7));
  const endY = Number(endDate.slice(0, 4));
  const endM = Number(endDate.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push({ year: y, month: m });
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

const OPTIONAL_CONTROL_KEYS = [
  "employeePayable", "retainageReceivable", "laborWip", "laborClearing",
  "unbilledReceivable", "projectRevenue", "payrollVariance",
] as const;

export async function provisionCorpusOrg(
  corpus: Pick<Corpus, "name" | "currency" | "country" | "startDate" | "endDate" | "accounts" | "parties" | "projects">,
): Promise<CorpusWorld> {
  for (const required of ["ar", "ap", "bank"]) {
    if (!corpus.accounts.some((a) => a.key === required)) {
      throw new Error(`corpus must declare a "${required}" account (control account)`);
    }
  }

  return withBypass(async () => {
    const orgId = randomUUID();
    await db.execute(sql`
      insert into orgs (id, name, base_currency, country, settings, env_kind)
      values (${orgId}, ${SIM_ORG_PREFIX + corpus.name}, ${corpus.currency}, ${corpus.country}, '{}'::jsonb, 'production')`);

    const fiscalCalendarId = randomUUID();
    await db.execute(sql`
      insert into fiscal_calendars (id, org_id, name, cadence, year_start_month, week_starts_on, time_zone,
                                    adjustment_period_enabled, is_default, is_active, config)
      values (${fiscalCalendarId}, ${orgId}, 'Default', 'monthly', 1, 1, 'UTC', false, true, true, '{}'::jsonb)`);

    const bookId = randomUUID();
    await db.execute(sql`
      insert into accounting_books (id, org_id, code, name, is_primary, is_active, posts_gl)
      values (${bookId}, ${orgId}, 'PRI', 'Primary', true, true, true)`);

    const subsidiaryId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${subsidiaryId}, ${orgId}, 'Main Co', ${corpus.currency}, ${corpus.country}, '{}'::jsonb, false, true, '{}'::jsonb)`);

    await db.execute(sql`
      insert into locations (id, org_id, name, is_active, custom, subsidiary_include_children)
      values (${randomUUID()}, ${orgId}, 'HQ', true, '{}'::jsonb, true)`);

    const periods: SimPeriod[] = [];
    for (const { year, month } of monthsInWindow(corpus.startDate, corpus.endDate)) {
      const id = randomUUID();
      const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
      const endsOn = lastDayOfMonth(year, month);
      const name = `${year}-${String(month).padStart(2, "0")}`;
      await db.execute(sql`
        insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
        values (${id}, ${orgId}, ${year}, ${month}, ${name}, ${startsOn}, ${endsOn}, false, ${fiscalCalendarId})`);
      periods.push({ id, fiscalYear: year, month, name, startsOn, endsOn });
    }

    const accounts: Record<string, string> = {};
    for (const a of corpus.accounts) {
      const id = randomUUID();
      accounts[a.key] = id;
      await db.execute(sql`
        insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
        values (${id}, ${orgId}, ${a.number}, ${a.name}, ${a.type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
    }

    const control: Record<string, string> = { ar: accounts.ar!, ap: accounts.ap!, bank: accounts.bank! };
    for (const k of OPTIONAL_CONTROL_KEYS) {
      if (accounts[k]) control[k] = accounts[k]!;
    }
    if (accounts.fxGainLoss) control.fxRealizedGainLoss = accounts.fxGainLoss;
    const settings = { simHarness: true, simProfile: `corpus:${corpus.name}`, controlAccounts: control };
    await db.execute(sql`update orgs set settings = ${JSON.stringify(settings)}::jsonb where id = ${orgId}`);

    const partyIds: Record<string, string> = {};
    for (const p of corpus.parties) {
      partyIds[p.key] = await insertParty(orgId, p);
    }

    const adminId = randomUUID();
    await db.transaction(async (tx) => {
      const role = (await tx.execute<{ id: string }>(sql`
        insert into app_roles (org_id, key, name, is_built_in, permissions)
        values (${orgId}, 'admin', 'admin', false, '[]'::jsonb)
        on conflict (org_id, key) do update set updated_at = now()
        returning id
      `));
      await tx.execute(sql`
        insert into users (id, org_id, email, name, password_hash, is_active)
        values (${adminId}, ${orgId}, ${`replay-${adminId.slice(0, 8)}@sim.test`}, 'Replay Operator', 'x', true)
      `);
      await tx.execute(sql`
        insert into role_assignments (org_id, user_id, role_id)
        values (${orgId}, ${adminId}, ${role.rows[0]!.id})
      `);
    });

    await provisionOrganizationDefaults(orgId, adminId);

    const projectIds: Record<string, string> = {};
    if (corpus.projects?.length) {
      const typeByKey = new Map(
        ((await db.execute<{ id: string; key: string }>(sql`
          select id, key from project_types where org_id = ${orgId} and is_active`))).rows.map((t) => [t.key, t.id]),
      );
      for (const spec of corpus.projects) {
        projectIds[spec.key] = await insertProject(orgId, spec, {
          typeId: typeByKey.get(spec.method) ?? null,
          customerId: partyIds[spec.customer],
          startsOn: corpus.startDate,
          incomeAccountId: accounts.revenueService ?? accounts.ar!,
        });
      }
    }

    const world: SimOrg = {
      orgId,
      bookId,
      subsidiaryId,
      fiscalCalendarId,
      currency: corpus.currency,
      accounts,
      // The replay drives explicit corpus events, so the seeded population specs
      // are inert — only ids matter to the activity primitives.
      vendors: corpus.parties
        .filter((p) => p.roles.includes("vendor"))
        .map((p) => ({ id: partyIds[p.key]!, name: p.name, termDays: 30, expenseCategories: [], billMin: 0, billMax: 0 })),
      customers: corpus.parties
        .filter((p) => p.roles.includes("customer"))
        .map((p) => ({
          id: partyIds[p.key]!, name: p.name, termDays: 30, revenueCategories: [], invoiceMin: 0, invoiceMax: 0,
          payment: { onTime: 1, late: 0, veryLate: 0, shortPay: 0, delinquent: 0 },
        })),
      actors: { apClerk: adminId, arClerk: adminId, controller: adminId, admin: adminId },
      periods,
      employees: corpus.parties
        .filter((p) => p.roles.includes("employee"))
        .map((p) => ({ id: partyIds[p.key]!, name: p.name, costRate: "0", billRate: "0" })),
      timeTypeId: null,
      laborItemId: null,
      engagements: [],
      jobs: [],
      subscriptions: [],
    };
    return { world, partyIds, projectIds };
  });
}

async function insertParty(orgId: string, p: CorpusParty): Promise<string> {
  const id = randomUUID();
  const primaryKind = p.roles.includes("customer") ? "customer" : p.roles.includes("vendor") ? "vendor" : "employee";
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${id}, ${orgId}, ${primaryKind}, ${p.name}, true, '{}'::jsonb)`);
  if (p.roles.includes("customer")) {
    await db.execute(sql`insert into customer_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  }
  if (p.roles.includes("vendor")) {
    await db.execute(sql`insert into vendor_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  }
  if (p.roles.includes("employee")) {
    await db.execute(sql`insert into employee_roles (id, org_id, party_id) values (${randomUUID()}, ${orgId}, ${id})`);
  }
  return id;
}

async function insertProject(
  orgId: string,
  spec: CorpusProject,
  opts: { typeId: string | null; customerId: string | undefined; startsOn: string; incomeAccountId: string },
): Promise<string> {
  if (!opts.typeId) throw new Error(`corpus project "${spec.key}": unknown project-type key "${spec.method}"`);
  if (!opts.customerId) throw new Error(`corpus project "${spec.key}": unknown customer "${spec.customer}"`);
  const id = randomUUID();
  const sovTotal = spec.sovLines?.reduce((a, l) => a + Number(l.scheduledValue), 0) ?? 0;
  const contractValue = spec.contractValue ?? String(sovTotal);
  await db.execute(sql`
    insert into projects (id, org_id, name, code, status, project_type_id, customer_id, contract_value, starts_on)
    values (${id}, ${orgId}, ${spec.name}, ${spec.key}, 'active', ${opts.typeId}, ${opts.customerId}, ${contractValue}, ${opts.startsOn})`);
  let sort = 0;
  for (const line of spec.sovLines ?? []) {
    await db.execute(sql`
      insert into sov_lines (id, org_id, project_id, description, scheduled_value, income_account_id, sort_order)
      values (${randomUUID()}, ${orgId}, ${id}, ${line.description}, ${line.scheduledValue}, ${opts.incomeAccountId}, ${sort++})`);
  }
  return id;
}
