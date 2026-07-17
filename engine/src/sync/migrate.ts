import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { CLOSE_MODULES, ensureCloseDefaults } from "../close.ts";
import type { MigrationSource, SourceEntity } from "./source.ts";

/**
 * Master-data loader for full migrations AND incremental mirrors. Drives the
 * canonical entity streams an adapter exposes (`source.entities(since)`) into
 * openbooks, source-driven and idempotent — the generalized successor to the
 * one-shot seed/import scripts.
 *
 * Every landed row records its source id under `custom[refKey]`; re-running
 * upserts by that key (never duplicates). Streams load in dependency order so a
 * later stream's foreign refs (a project's customer, a time entry's employee)
 * resolve against rows landed by an earlier stream. Reference maps are built
 * from the DB up front and grow as rows land.
 */

export interface ResourceLoadStats {
  created: number;
  updated: number;
  skipped: number;
}
export type EntityLoadStats = Record<string, ResourceLoadStats>;

/** Resources this loader knows how to land. */
const KNOWN = new Set([
  "accounting_periods", "subsidiaries", "accounts", "departments", "payment_terms", "time_types", "tax_codes", "items",
  "parties", "projects", "addresses", "contacts", "time_entries",
]);

type RefMaps = {
  subsidiaries: Map<string, string>;
  accounts: Map<string, string>;
  departments: Map<string, string>;
  tax_codes: Map<string, string>;
  parties: Map<string, string>;
  projects: Map<string, string>;
  items: Map<string, string>;
  time_types: Map<string, string>;
  payment_terms: Map<string, string>;
};
interface Ctx {
  orgId: string;
  refKey: string;
  currency: string;
  incremental: boolean;
  maps: RefMaps;
  usedShortCodes: Set<string>;
}

const ref = (m: Map<string, string>, v: unknown): string | null =>
  v == null || v === "" ? null : m.get(String(v)) ?? null;
const str = (v: unknown): string | null => {
  const t = v == null ? "" : String(v);
  return t.trim() === "" ? null : t;
};

async function loadMap(table: string, orgId: string, refKey: string): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const rows = (await db.execute(sql`
    select id, custom->>${refKey} ns from ${sql.raw(table)}
     where org_id = ${orgId} and custom->>${refKey} is not null`)) as { rows: { id: string; ns: string }[] };
  for (const r of rows.rows) m.set(r.ns, r.id);
  return m;
}

/** Self-heal schema drift the way the import scripts do (live DB predates cols). */
async function ensureSchema(): Promise<void> {
  await db.execute(sql`alter table addresses add column if not exists custom jsonb not null default '{}'::jsonb`);
  await db.execute(sql`alter table payment_terms add column if not exists custom jsonb not null default '{}'::jsonb`);
  await db.execute(sql`alter table time_types add column if not exists custom jsonb not null default '{}'::jsonb`);
  await db.execute(sql`alter table time_entries add column if not exists custom jsonb not null default '{}'::jsonb`);
  await db.execute(sql`
    create table if not exists contacts (
      id uuid primary key default uuid_generate_v7(),
      org_id uuid not null, party_id uuid,
      first_name text, last_name text, name text not null,
      title text, role text, email text, phone text, mobile_phone text, fax text,
      is_primary boolean not null default false, is_active boolean not null default true,
      custom jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(), created_by uuid,
      updated_at timestamptz not null default now(), updated_by uuid)`);
  await db.execute(sql`create index if not exists contacts_party on contacts (party_id)`);
}

export async function loadEntities(
  source: MigrationSource,
  orgId: string,
  since: Date | null = null,
): Promise<EntityLoadStats> {
  if (!source.entities) return {};
  await ensureSchema();
  const refKey = source.refKey;
  const ctx: Ctx = {
    orgId, refKey, currency: source.baseCurrency, incremental: since != null,
    usedShortCodes: new Set(),
    maps: {
      subsidiaries: await loadMap("subsidiaries", orgId, refKey),
      accounts: await loadMap("accounts", orgId, refKey),
      departments: await loadMap("departments", orgId, refKey),
      tax_codes: await loadMap("tax_codes", orgId, refKey),
      parties: await loadMap("parties", orgId, refKey),
      projects: await loadMap("projects", orgId, refKey),
      items: await loadMap("items", orgId, refKey),
      time_types: await loadMap("time_types", orgId, refKey),
      payment_terms: await loadMap("payment_terms", orgId, refKey),
    },
  };

  const streams = [
    { resource: "accounting_periods", records: await source.accountingPeriods() },
    ...(await source.entities(since)),
  ];
  const stats: EntityLoadStats = {};

  for (const stream of streams) {
    if (!KNOWN.has(stream.resource)) {
      stats[stream.resource] = { created: 0, updated: 0, skipped: stream.records.length };
      continue;
    }
    const s: ResourceLoadStats = { created: 0, updated: 0, skipped: 0 };

    if (stream.resource === "accounting_periods") {
      await loadAccountingPeriods(stream.records, ctx.orgId, s);
      stats[stream.resource] = s;
      continue;
    }

    if (stream.resource === "subsidiaries") {
      await loadSubsidiaries(stream.records, ctx, s);
      stats[stream.resource] = s;
      continue;
    }

    // time_entries is high-volume — bulk path (batched inserts, skip unchanged
    // on a full load, update on an incremental pull).
    if (stream.resource === "time_entries") {
      await loadTimeEntries(stream.records, ctx, s);
      stats[stream.resource] = s;
      continue;
    }

    const idByRef = new Map<string, string>();
    for (const rec of stream.records) {
      try {
        const id = await upsert(stream.resource, ctx, rec, s);
        if (id) {
          idByRef.set(rec.sourceRef, id);
          const map = (ctx.maps as any)[stream.resource] as Map<string, string> | undefined;
          if (map) map.set(rec.sourceRef, id);
        }
      } catch (e) {
        s.skipped++;
        void e;
      }
    }

    if (stream.resource === "accounts") {
      for (const rec of stream.records) {
        if (!rec.parentRef) continue;
        const child = idByRef.get(rec.sourceRef);
        const parent = idByRef.get(rec.parentRef);
        if (child && parent) await db.execute(sql`update accounts set parent_id = ${parent} where id = ${child}`);
      }
    }
    stats[stream.resource] = s;
  }
  return stats;
}

/**
 * Land source posting periods and their module lock state. Source adapters
 * normalize vendor-specific flags into the fields consumed here, keeping the
 * migration kernel vendor-neutral. Imported locks remain source-owned while
 * their reason is `close.importedPeriodLockReason`; a lock changed in openbooks
 * gains a user reason and is never overwritten by a later mirror.
 */
async function loadAccountingPeriods(
  records: SourceEntity[],
  orgId: string,
  s: ResourceLoadStats,
): Promise<void> {
  const defaults = await ensureCloseDefaults(orgId);
  const books = (await db.execute(sql`
    select id from accounting_books
     where org_id = ${orgId} and is_active
     order by is_primary desc, created_at
  `)) as { rows: { id: string }[] };
  if (books.rows.length === 0) {
    s.skipped += records.length;
    return;
  }

  for (const rec of records) {
    const f = rec.fields;
    const fiscalYear = Number(f.fiscalYear);
    const periodNumber = Number(f.periodNumber);
    const name = str(f.name);
    const startsOn = str(f.startsOn);
    const endsOn = str(f.endsOn);
    if (
      !name || !startsOn || !endsOn ||
      !Number.isInteger(fiscalYear) || !Number.isInteger(periodNumber) ||
      periodNumber < 1
    ) {
      s.skipped++;
      continue;
    }

    const existing = (await db.execute(sql`
      select id from accounting_periods
       where org_id = ${orgId}
         and fiscal_calendar_id = ${defaults.calendarId}
         and fiscal_year = ${fiscalYear}
         and period_number = ${periodNumber}
       limit 1
    `)) as { rows: { id: string }[] };
    const period = (await db.execute(sql`
      insert into accounting_periods
        (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment)
      values (${orgId}, ${defaults.calendarId}, ${fiscalYear}, ${periodNumber},
              ${name}, ${startsOn}, ${endsOn}, ${f.isAdjustment === true})
      on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number)
      do update set name = excluded.name, starts_on = excluded.starts_on,
        ends_on = excluded.ends_on, is_adjustment = excluded.is_adjustment,
        updated_at = now()
      returning id
    `)) as { rows: { id: string }[] };
    const periodId = period.rows[0]?.id;
    if (!periodId) {
      s.skipped++;
      continue;
    }
    existing.rows[0] ? s.updated++ : s.created++;

    const fullyClosed = f.closed === true || f.allLocked === true;
    const moduleStates = f.moduleStates && typeof f.moduleStates === "object" && !Array.isArray(f.moduleStates)
      ? f.moduleStates as Record<string, unknown>
      : {};
    const closedAt = str(f.closedAt);
    for (const book of books.rows) {
      for (const module of CLOSE_MODULES) {
        const closed = fullyClosed ||
          (module === "ar" && f.arLocked === true) ||
          (module === "ap" && f.apLocked === true);
        const explicitState = moduleStates[module];
        const state = explicitState === "closed" || explicitState === "soft_closed" || explicitState === "open"
          ? explicitState
          : closed ? "closed" : "open";
        await db.execute(sql`
          insert into period_locks
            (org_id, period_id, book_id, module, state, locked_at, reason)
          values (${orgId}, ${periodId}, ${book.id}, ${module},
                  ${state},
                  ${state !== "open" ? closedAt : null},
                  'close.importedPeriodLockReason')
          on conflict (org_id, period_id, book_id, subsidiary_id, module)
          do update set state = excluded.state,
            locked_at = excluded.locked_at,
            reason = excluded.reason,
            reopen_expires_at = null,
            version = period_locks.version + 1,
            updated_at = now()
          where period_locks.reason is null
             or period_locks.reason = 'close.importedPeriodLockReason'
        `);
      }
    }
  }
}

/** Refresh only period definitions and lock state; safe for a live mirror. */
export async function syncSourceAccountingPeriods(
  source: MigrationSource,
  orgId: string,
): Promise<ResourceLoadStats> {
  const stats: ResourceLoadStats = { created: 0, updated: 0, skipped: 0 };
  await loadAccountingPeriods(await source.accountingPeriods(), orgId, stats);
  return stats;
}

async function findByRef(table: string, orgId: string, refKey: string, sourceRef: string) {
  const existing = (await db.execute(sql`
    select id from ${sql.raw(table)} where org_id = ${orgId} and custom->>${refKey} = ${sourceRef} limit 1`)) as {
    rows: { id: string }[];
  };
  return existing.rows[0]?.id ?? null;
}

async function loadSubsidiaries(records: SourceEntity[], ctx: Ctx, s: ResourceLoadStats): Promise<void> {
  const pending = [...records];
  while (pending.length > 0) {
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const rec = pending[i]!;
      if (rec.parentRef && !ctx.maps.subsidiaries.has(rec.parentRef)) continue;
      try {
        const id = await upsert("subsidiaries", ctx, rec, s);
        if (id) ctx.maps.subsidiaries.set(rec.sourceRef, id);
      } catch {
        s.skipped++;
      }
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) {
      s.skipped += pending.length;
      return;
    }
  }
}

async function upsert(resource: string, ctx: Ctx, rec: SourceEntity, s: ResourceLoadStats): Promise<string | null> {
  const f = rec.fields;
  const { orgId, refKey } = ctx;
  const custom = JSON.stringify({ [refKey]: rec.sourceRef });

  if (resource === "subsidiaries") {
    const name = String(f.name ?? `Subsidiary ${rec.sourceRef}`);
    const legalName = str(f.legalName);
    const baseCurrency = String(f.baseCurrency ?? ctx.currency).toUpperCase();
    const country = String(f.country ?? "US").toUpperCase();
    const parentId = rec.parentRef ? ctx.maps.subsidiaries.get(rec.parentRef) ?? null : null;
    let id = await findByRef("subsidiaries", orgId, refKey, rec.sourceRef);
    if (!id && !rec.parentRef) {
      const root = (await db.execute(sql`
        select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1`)) as {
        rows: { id: string }[];
      };
      id = root.rows[0]?.id ?? null;
    }
    if (id) {
      await db.execute(sql`
        update subsidiaries set name = ${name}, legal_name = ${legalName},
          base_currency = ${baseCurrency}, country = ${country},
          is_elimination = ${!!f.isElimination}, is_active = ${f.isActive !== false},
          custom = custom || ${custom}::jsonb, updated_at = now()
         where id = ${id} and org_id = ${orgId}`);
      s.updated++;
      return id;
    }
    if (rec.parentRef && !parentId) throw new Error(`subsidiary parent ${rec.parentRef} is not loaded`);
    const ins = (await db.execute(sql`
      insert into subsidiaries
        (org_id, parent_id, name, legal_name, base_currency, country, is_elimination, is_active, custom)
      values (${orgId}, ${parentId}, ${name}, ${legalName}, ${baseCurrency}, ${country},
              ${!!f.isElimination}, ${f.isActive !== false}, ${custom}::jsonb)
      returning id`)) as { rows: { id: string }[] };
    s.created++;
    return ins.rows[0]?.id ?? null;
  }

  if (resource === "accounts") {
    const type = String(f.type ?? "");
    if (!type) { s.skipped++; return null; }
    const id = await findByRef("accounts", orgId, refKey, rec.sourceRef);
    const vals = {
      name: String(f.name ?? `Account ${rec.sourceRef}`), type,
      isSummary: !!f.isSummary, isActive: f.isActive !== false, eliminate: !!f.eliminate, reconcilable: !!f.reconcilable,
    };
    if (id) {
      await db.execute(sql`update accounts set name=${vals.name}, type=${vals.type}::text,
        is_summary=${vals.isSummary}, is_active=${vals.isActive}, eliminate=${vals.eliminate}, reconcilable=${vals.reconcilable}
        where id=${id}`);
      s.updated++; return id;
    }
    const ins = (await db.execute(sql`insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, custom)
      values (${orgId}, ${(f.number as string) ?? null}, ${vals.name}, ${vals.type}::text, ${vals.isSummary}, ${vals.isActive}, ${vals.eliminate}, ${vals.reconcilable}, ${custom}::jsonb)
      returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "departments") {
    const name = String(f.name ?? `Department ${rec.sourceRef}`);
    const id = await findByRef("departments", orgId, refKey, rec.sourceRef);
    if (id) { await db.execute(sql`update departments set name=${name} where id=${id}`); s.updated++; return id; }
    const ins = (await db.execute(sql`insert into departments (org_id, name, custom) values (${orgId}, ${name}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "payment_terms") {
    const name = String(f.name ?? `Term ${rec.sourceRef}`);
    // match by nsId, else by name (reconciles with name-seeded rows).
    let id = await findByRef("payment_terms", orgId, refKey, rec.sourceRef);
    if (!id) {
      const byName = (await db.execute(sql`select id from payment_terms where org_id=${orgId} and name=${name} limit 1`)) as { rows: { id: string }[] };
      id = byName.rows[0]?.id ?? null;
    }
    const netDays = Number(f.netDays ?? 30);
    if (id) {
      await db.execute(sql`update payment_terms set name=${name}, net_days=${netDays}, discount_days=${(f.discountDays as number) ?? null},
        discount_percent=${(f.discountPercent as string) ?? null}, custom=${custom}::jsonb where id=${id}`);
      s.updated++; return id;
    }
    const ins = (await db.execute(sql`insert into payment_terms (org_id, name, net_days, discount_days, discount_percent, custom)
      values (${orgId}, ${name}, ${netDays}, ${(f.discountDays as number) ?? null}, ${(f.discountPercent as string) ?? null}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "time_types") {
    const name = String(f.name ?? `Time type ${rec.sourceRef}`);
    const mult = String(f.costMultiplier ?? "1");
    const id = await findByRef("time_types", orgId, refKey, rec.sourceRef);
    if (id) { await db.execute(sql`update time_types set name=${name}, cost_multiplier=${mult}, is_active=${f.isActive !== false} where id=${id}`); s.updated++; return id; }
    const ins = (await db.execute(sql`insert into time_types (org_id, name, cost_multiplier, is_active, custom)
      values (${orgId}, ${name}, ${mult}, ${f.isActive !== false}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "tax_codes") {
    // fields: { code, name, ratePercent, appliesTo? } — a code plus its dated
    // rate row (rate-keyed lookup powers the builders' ctx.taxByRate).
    const code = String(f.code ?? `TAX-${rec.sourceRef}`);
    const name = String(f.name ?? code);
    const appliesTo = String(f.appliesTo ?? "both");
    const rate = String(f.ratePercent ?? "0");
    let id = await findByRef("tax_codes", orgId, refKey, rec.sourceRef);
    if (!id) {
      const byCode = (await db.execute(sql`select id from tax_codes where org_id=${orgId} and code=${code} limit 1`)) as { rows: { id: string }[] };
      id = byCode.rows[0]?.id ?? null;
    }
    // Optional per-code control accounts (source refs → openbooks ids).
    const acctId = async (ref: unknown): Promise<string | null> => {
      if (!ref) return null;
      const r = (await db.execute(sql`
        select id from accounts where org_id=${orgId} and custom->>${refKey} = ${String(ref)} limit 1`)) as { rows: { id: string }[] };
      return r.rows[0]?.id ?? null;
    };
    const collected = await acctId(f.collectedAccountRef);
    const paid = await acctId(f.paidAccountRef);
    if (id) {
      await db.execute(sql`update tax_codes set name=${name}, applies_to=${appliesTo}::text,
        collected_account_id=coalesce(${collected}, collected_account_id),
        paid_account_id=coalesce(${paid}, paid_account_id), custom=${custom}::jsonb where id=${id}`);
      await db.execute(sql`update tax_rates set rate_percent=${rate} where tax_code_id=${id}`);
      s.updated++; return id;
    }
    const ins = (await db.execute(sql`insert into tax_codes (org_id, code, name, applies_to, collected_account_id, paid_account_id, custom)
      values (${orgId}, ${code}, ${name}, ${appliesTo}::text, ${collected}, ${paid}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    const newId = ins.rows[0]?.id ?? null;
    if (newId) {
      await db.execute(sql`insert into tax_rates (org_id, tax_code_id, rate_percent, effective_from)
        values (${orgId}, ${newId}, ${rate}, '1970-01-01')`);
    }
    s.created++; return newId;
  }

  if (resource === "items") {
    const name = String(f.name ?? `Item ${rec.sourceRef}`);
    const id = await findByRef("items", orgId, refKey, rec.sourceRef);
    if (id) { await db.execute(sql`update items set name=${name}, kind=${String(f.kind ?? "service")}::text, category=${str(f.category)}, is_active=${f.isActive !== false} where id=${id}`); s.updated++; return id; }
    const ins = (await db.execute(sql`insert into items (org_id, kind, code, name, category, is_active, custom)
      values (${orgId}, ${String(f.kind ?? "service")}::text, ${(f.code as string) ?? null}, ${name}, ${str(f.category)}, ${f.isActive !== false}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "projects") {
    const name = String(f.name ?? `Project ${rec.sourceRef}`);
    const vals = {
      code: str(f.code), status: String(f.status ?? "active"), billing: str(f.billingMethod),
      customer: ref(ctx.maps.parties, f.customerRef), foreman: ref(ctx.maps.parties, f.foremanRef),
      manager: ref(ctx.maps.parties, f.managerRef), po: str(f.customerPoNumber),
      starts: str(f.startsOn), ends: str(f.endsOn), isActive: f.isActive !== false,
    };
    const id = await findByRef("projects", orgId, refKey, rec.sourceRef);
    if (id) {
      await db.execute(sql`update projects set name=${name}, code=${vals.code}, status=${vals.status}::text,
        billing_method=${vals.billing}, customer_id=${vals.customer}, foreman_id=${vals.foreman}, manager_id=${vals.manager},
        customer_po_number=${vals.po}, starts_on=${vals.starts}, ends_on=${vals.ends}, is_active=${vals.isActive} where id=${id}`);
      s.updated++; return id;
    }
    const ins = (await db.execute(sql`insert into projects (org_id, name, code, status, billing_method, customer_id, foreman_id, manager_id, customer_po_number, starts_on, ends_on, is_active, custom)
      values (${orgId}, ${name}, ${vals.code}, ${vals.status}::text, ${vals.billing}, ${vals.customer}, ${vals.foreman}, ${vals.manager}, ${vals.po}, ${vals.starts}, ${vals.ends}, ${vals.isActive}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "addresses") {
    const pid = ref(ctx.maps.parties, f.entityRef);
    if (!pid) { s.skipped++; return null; }
    const v = {
      label: str(f.label), line1: str(f.line1), line2: str(f.line2), city: str(f.city),
      region: str(f.region), postal: str(f.postalCode), country: str(f.country),
      db: !!f.isDefaultBilling, ds: !!f.isDefaultShipping,
    };
    const id = await findByRef("addresses", orgId, refKey, rec.sourceRef);
    if (id) {
      await db.execute(sql`update addresses set party_id=${pid}, label=${v.label}, line1=${v.line1}, line2=${v.line2},
        city=${v.city}, region=${v.region}, postal_code=${v.postal}, country=${v.country},
        is_default_billing=${v.db}, is_default_shipping=${v.ds} where id=${id}`);
      s.updated++; return id;
    }
    const ins = (await db.execute(sql`insert into addresses (org_id, party_id, label, line1, line2, city, region, postal_code, country, is_default_billing, is_default_shipping, custom)
      values (${orgId}, ${pid}, ${v.label}, ${v.line1}, ${v.line2}, ${v.city}, ${v.region}, ${v.postal}, ${v.country}, ${v.db}, ${v.ds}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  if (resource === "contacts") {
    const pid = ref(ctx.maps.parties, f.companyRef);
    const v = {
      name: String(f.name ?? "Contact"), first: str(f.firstName), last: str(f.lastName), title: str(f.title),
      role: str(f.role), email: str(f.email), phone: str(f.phone), mobile: str(f.mobilePhone), fax: str(f.fax),
      primary: !!f.isPrimary, isActive: f.isActive !== false,
    };
    const id = await findByRef("contacts", orgId, refKey, rec.sourceRef);
    if (id) {
      await db.execute(sql`update contacts set party_id=${pid}, name=${v.name}, first_name=${v.first}, last_name=${v.last},
        title=${v.title}, role=${v.role}, email=${v.email}, phone=${v.phone}, mobile_phone=${v.mobile}, fax=${v.fax},
        is_primary=${v.primary}, is_active=${v.isActive} where id=${id}`);
      s.updated++; return id;
    }
    const ins = (await db.execute(sql`insert into contacts (org_id, party_id, name, first_name, last_name, title, role, email, phone, mobile_phone, fax, is_primary, is_active, custom)
      values (${orgId}, ${pid}, ${v.name}, ${v.first}, ${v.last}, ${v.title}, ${v.role}, ${v.email}, ${v.phone}, ${v.mobile}, ${v.fax}, ${v.primary}, ${v.isActive}, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    s.created++; return ins.rows[0]?.id ?? null;
  }

  // parties (+ role)
  const displayName = String(f.displayName ?? `Party ${rec.sourceRef}`);
  const kind = f.kind === "person" ? "person" : "company";
  const isActive = f.isActive !== false;
  const subsidiaryId = ref(ctx.maps.subsidiaries, f.subsidiaryRef);
  const taxIds = JSON.stringify((f.taxIds as Record<string, string>) ?? {});
  let pid = await findByRef("parties", orgId, refKey, rec.sourceRef);
  if (pid) {
    await db.execute(sql`update parties set display_name=${displayName}, kind=${kind}::text, is_active=${isActive},
      subsidiary_id=coalesce(${subsidiaryId}, subsidiary_id),
      email=coalesce(${str(f.email)}, email), phone=coalesce(${str(f.phone)}, phone),
      website=coalesce(${str(f.website)}, website), legal_name=coalesce(${str(f.legalName)}, legal_name),
      tax_ids=${taxIds}::jsonb where id=${pid}`);
    s.updated++;
  } else {
    const ins = (await db.execute(sql`insert into parties (org_id, kind, display_name, is_active, subsidiary_id, email, phone, website, legal_name, tax_ids, custom)
      values (${orgId}, ${kind}::text, ${displayName}, ${isActive}, ${subsidiaryId}, ${str(f.email)}, ${str(f.phone)}, ${str(f.website)}, ${str(f.legalName)}, ${taxIds}::jsonb, ${custom}::jsonb) returning id`)) as { rows: { id: string }[] };
    pid = ins.rows[0]?.id ?? null;
    s.created++;
  }
  if (!pid) return null;

  // short code — set only if it's free in the org (unique constraint).
  const shortCode = str(f.shortCode);
  if (shortCode) {
    await db.execute(sql`update parties set short_code=${shortCode} where id=${pid}
      and not exists (select 1 from parties p2 where p2.org_id=${orgId} and p2.short_code=${shortCode} and p2.id<>${pid})`);
  }

  // role
  if (f.customerRole) {
    const r = f.customerRole as Record<string, unknown>;
    await upsertRole("customer_roles", orgId, pid, {
      ar_account_id: ref(ctx.maps.accounts, r.arAccountRef),
      payment_terms_id: ref(ctx.maps.payment_terms, r.termsRef),
      credit_limit: str(r.creditLimit), currency: ctx.currency,
      sales_rep_id: ref(ctx.maps.parties, r.salesRepRef),
      tax_code_id: ref(ctx.maps.tax_codes, r.taxCodeRef), is_active: isActive,
    });
  } else if (f.vendorRole) {
    const r = f.vendorRole as Record<string, unknown>;
    await upsertRole("vendor_roles", orgId, pid, {
      ap_account_id: ref(ctx.maps.accounts, r.apAccountRef),
      payment_terms_id: ref(ctx.maps.payment_terms, r.termsRef),
      default_expense_account_id: ref(ctx.maps.accounts, r.defaultExpenseAccountRef),
      currency: ctx.currency, is_t4a: !!r.is1099OrT4a, is_active: isActive,
    });
  } else if (f.employeeRole) {
    const r = f.employeeRole as Record<string, unknown>;
    await upsertRole("employee_roles", orgId, pid, {
      employee_number: str(r.employeeNumber),
      department_id: ref(ctx.maps.departments, r.departmentRef),
      supervisor_id: ref(ctx.maps.parties, r.supervisorRef),
      hired_on: str(r.hiredOn), terminated_on: str(r.terminatedOn),
      has_benefits: !!r.hasBenefits, is_active: isActive,
    });
  }
  return pid;
}

/** Insert/update a role row keyed on the unique party_id. */
async function upsertRole(table: string, orgId: string, partyId: string, cols: Record<string, unknown>) {
  const keys = Object.keys(cols);
  const colList = keys.map((k) => sql.raw(k));
  const valList = keys.map((k) => sql`${cols[k] as any}`);
  const setList = keys.map((k) => sql`${sql.raw(k)} = ${cols[k] as any}`);
  await db.execute(sql`
    insert into ${sql.raw(table)} (org_id, party_id, ${sql.join(colList, sql`, `)})
    values (${orgId}, ${partyId}, ${sql.join(valList, sql`, `)})
    on conflict (party_id) do update set ${sql.join(setList, sql`, `)}`);
}

/** High-volume time-entry loader — batched inserts; skip-unchanged on full load. */
async function loadTimeEntries(records: SourceEntity[], ctx: Ctx, s: ResourceLoadStats) {
  const { orgId, refKey } = ctx;
  const existing = new Map<string, string>();
  const rows = (await db.execute(sql`
    select id, custom->>${refKey} ns from time_entries where org_id=${orgId} and custom->>${refKey} is not null`)) as {
    rows: { id: string; ns: string }[];
  };
  for (const r of rows.rows) existing.set(r.ns, r.id);

  const BATCH = 500;
  let batch: SourceEntity[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const b = batch; batch = [];
    const values = b.map((rec) => {
      const f = rec.fields;
      return sql`(${orgId}, ${ref(ctx.maps.parties, f.employeeRef)!}, ${str(f.workedOn) ?? "1970-01-01"},
        ${str(f.hours) ?? "0"}, ${ref(ctx.maps.time_types, f.timeTypeRef)}, ${ref(ctx.maps.items, f.itemRef)},
        ${ref(ctx.maps.projects, f.projectRef)}, ${ref(ctx.maps.departments, f.departmentRef)},
        ${!!f.isBillable}, ${str(f.costRate)}, ${str(f.billRate)}, 'approved',
        ${JSON.stringify({ [refKey]: rec.sourceRef })}::jsonb)`;
    });
    await db.execute(sql`insert into time_entries
      (org_id, employee_party_id, worked_on, hours, time_type_id, item_id, project_id, department_id, is_billable, cost_rate, bill_rate, status, custom)
      values ${sql.join(values, sql`, `)}`);
    s.created += b.length;
  };

  for (const rec of records) {
    const f = rec.fields;
    const empId = ref(ctx.maps.parties, f.employeeRef);
    if (!empId) { s.skipped++; continue; }
    const id = existing.get(rec.sourceRef);
    if (id) {
      // A full load re-emits everything; only touch existing rows when the pull
      // was incremental (i.e. the source flagged them changed).
      if (!ctx.incremental) { s.skipped++; continue; }
      await db.execute(sql`update time_entries set worked_on=${str(f.workedOn) ?? "1970-01-01"}, hours=${str(f.hours) ?? "0"},
        time_type_id=${ref(ctx.maps.time_types, f.timeTypeRef)}, item_id=${ref(ctx.maps.items, f.itemRef)},
        project_id=${ref(ctx.maps.projects, f.projectRef)}, department_id=${ref(ctx.maps.departments, f.departmentRef)},
        is_billable=${!!f.isBillable}, cost_rate=${str(f.costRate)}, bill_rate=${str(f.billRate)} where id=${id}`);
      s.updated++;
      continue;
    }
    batch.push(rec);
    if (batch.length >= BATCH) await flush();
  }
  await flush();
}
