/** Organization, currency, subsidiary, role, and admin seeding. Split from scripts/bootstrap.ts (pure moves only). */
import { randomBytes, scryptSync } from "node:crypto"
import { sql } from "drizzle-orm"
import { db, env } from "../../engine/src/platform/db.ts"
import { ensureCloseDefaults } from "../../engine/src/close/defaults.ts"
import { SUPPORTED_CURRENCIES } from "../../engine/src/fx/currencies.ts"
import { BUILT_IN_ROLES } from "../../web/lib/permissions.ts"

export async function ensureOrg(): Promise<string> {
  const existing = (await db.execute<{ id: string }>(
    sql`select id from orgs order by created_at limit 1`,
  ));
  const existingRow = existing.rows[0];
  if (existingRow) return existingRow.id;

  const name = env.ORG_NAME || "OpenBooks";
  const currency = env.ORG_CURRENCY?.trim().toUpperCase();
  const country = env.ORG_COUNTRY?.trim().toUpperCase();
  if (!currency) {
    throw new Error("ORG_CURRENCY is required when creating the first organization");
  }
  if (!country || !/^[A-Z]{2}$/.test(country)) {
    throw new Error(
      "ORG_COUNTRY is required as an ISO 3166-1 alpha-2 code when creating the first organization",
    );
  }
  const ins = (await db.execute<{ id: string }>(sql`
    insert into orgs (name, base_currency, country) values (${name}, ${currency}, ${country})
    returning id
  `));
  const orgId = ins.rows[0]?.id;
  if (!orgId) throw new Error("org insert returned no id");
  console.log(`[bootstrap] created org "${name}" (${currency}/${country})`);

  await db.execute(sql`
    insert into accounting_books (org_id, code, name, is_primary)
    values (${orgId}, 'primary', 'Primary book', true)
    -- Fresh org id (minted two lines above) under the bootstrap-wide advisory
    -- lock: a conflict is not reachable, and doing nothing rather than
    -- failing keeps a re-run of this ensure idempotent.
    on conflict do nothing
  `);

  const { calendarId } = await ensureCloseDefaults(orgId);

  // Monthly periods: two fiscal years back through five ahead — plenty for a
  // dev instance; Setup → Periods & Close manages them afterwards.
  const thisYear = new Date().getUTCFullYear();
  for (let y = thisYear - 2; y <= thisYear + 5; y++) {
    for (let m = 1; m <= 12; m++) {
      const start = `${y}-${String(m).padStart(2, "0")}-01`;
      const endDate = new Date(Date.UTC(y, m, 0));
      const end = endDate.toISOString().slice(0, 10);
      await db.execute(sql`
        insert into accounting_periods (org_id, fiscal_calendar_id, fiscal_year, period_number, name, starts_on, ends_on)
        values (${orgId}, ${calendarId}, ${y}, ${m}, ${`${y}-${String(m).padStart(2, "0")}`}, ${start}, ${end})
        -- Fresh org + fresh calendar under the bootstrap-wide advisory lock;
        -- the conflict is not reachable and do-nothing keeps re-runs idempotent.
        on conflict do nothing
      `);
    }
  }
  console.log(
    `[bootstrap] primary book + periods ${thisYear - 2}..${thisYear + 5} ensured`,
  );
  return orgId;
}

export async function seedCurrencies(): Promise<void> {
  for (const currency of SUPPORTED_CURRENCIES) {
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values (${currency.code}, ${currency.name}, ${currency.minorUnits})
      on conflict (code) do update
        set name = excluded.name, minor_units = excluded.minor_units
    `);
  }
  const configured = env.ORG_CURRENCY?.trim().toUpperCase();
  if (configured && !SUPPORTED_CURRENCIES.some((currency) => currency.code === configured)) {
    throw new Error(
      `ORG_CURRENCY ${configured} is not in the supported ISO 4217 registry`,
    );
  }
  console.log(`[bootstrap] ${SUPPORTED_CURRENCIES.length} currencies ensured`);
}

export async function ensureRootSubsidiary(orgId: string): Promise<void> {
  await db.execute(sql`
    insert into subsidiaries
      (org_id, name, legal_name, base_currency, country, created_at, updated_at)
    select id, name, legal_name, base_currency, country, now(), now()
      from orgs
     where id = ${orgId}
       and not exists (
         select 1 from subsidiaries where org_id = ${orgId} and parent_id is null
       )
    -- The not-exists guard makes the insert conditional; the conflict arm
    -- only covers a lost race against another ensure, which the bootstrap-
    -- wide advisory lock already excludes. Do-nothing is the ensure's
    -- intent, and the re-read below fails loudly if the row is absent.
    on conflict do nothing
  `);
  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null
  `));
  if (root.rows.length !== 1) {
    throw new Error(`organization ${orgId} must have exactly one root subsidiary`);
  }
  console.log("[bootstrap] root subsidiary ensured");
}

export async function seedRoles(orgId: string): Promise<void> {
  for (const [key, def] of Object.entries(BUILT_IN_ROLES)) {
    await db.execute(sql`
      insert into app_roles (org_id, key, name, description, is_built_in, permissions)
      values (${orgId}, ${key}, ${def.name}, ${def.description}, true, ${JSON.stringify(def.permissions)})
      on conflict (org_id, key) do update
        set name = excluded.name, description = excluded.description,
            is_built_in = true, permissions = excluded.permissions, updated_at = now()
    `);
  }
  console.log("[bootstrap] built-in roles ensured");
}

export async function seedAdmin(orgId: string): Promise<void> {
  const email = env.ADMIN_EMAIL;
  if (!email) {
    console.log("[bootstrap] ADMIN_EMAIL not set — skipping admin seed");
    return;
  }
  const name = env.ADMIN_NAME || "Administrator";
  const password = env.ADMIN_PASSWORD || randomBytes(12).toString("base64url");
  const salt = randomBytes(16);
  const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
  // Only set the password when the user is first created — a running instance
  // must not have its admin password silently reset on every deploy.
  const created = await db.transaction(async (tx) => {
    const inserted = (await tx.execute<{ id: string }>(sql`
      insert into users (org_id, email, name, password_hash)
      values (${orgId}, ${email.toLowerCase()}, ${name}, ${hash})
      on conflict (org_id, email) do nothing
      returning id
    `));
    const userId = inserted.rows[0]?.id ?? ((await tx.execute<{ id: string }>(sql`
      select id from users where org_id = ${orgId} and email = ${email.toLowerCase()} limit 1
    `))).rows[0]?.id;
    if (!userId) throw new Error(`administrator ${email} could not be resolved after seed`);
    const assignment = (await tx.execute<{ id: string }>(sql`
      insert into role_assignments (org_id, user_id, role_id)
      select ${orgId}, ${userId}, id from app_roles
       where org_id = ${orgId} and key = 'admin'
      on conflict (org_id, user_id, role_id) do nothing
      returning id
    `));
    if (inserted.rows.length > 0 && assignment.rows.length === 0) {
      throw new Error("new administrator did not receive an explicit admin role assignment");
    }
    return inserted.rows.length > 0;
  });
  if (created) {
    console.log(
      `[bootstrap] admin user ${email} created${env.ADMIN_PASSWORD ? "" : ` — generated password: ${password}`}`,
    );
  } else {
    console.log(`[bootstrap] admin user ${email} already exists — untouched`);
  }
}

/**
 * First platform super-admin for a fresh self-hosted install. The platform
 * console authorizes on users.is_super_admin, and its only grant path is the
 * console itself, which already requires a super administrator — so a fresh
 * install could never reach it. When PLATFORM_ADMIN_EMAIL names an existing
 * user and no active super administrator exists anywhere in the
 * installation, that user is promoted; the grant is audited and logged.
 * It is a strict no-op once any active super administrator exists (later
 * grants are governed by the console) and when PLATFORM_ADMIN_EMAIL is
 * unset. The transaction lock serializes concurrent bootstraps so two
 * cannot both grant.
 */
export async function ensureFirstPlatformAdmin(): Promise<void> {
  const configured = env.PLATFORM_ADMIN_EMAIL?.trim();
  if (!configured) return;
  const email = configured.toLowerCase();
  const granted = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('openbooks:first-platform-admin', 0))`);
    const existing = (await tx.execute<{ id: string }>(sql`
      select id from users where is_super_admin and is_active limit 1
    `));
    if (existing.rows.length > 0) return false;
    const candidates = (await tx.execute<{
      id: string;
      org_id: string;
      email: string;
      is_active: boolean;
      is_super_admin: boolean;
    }>(sql`
      select id, org_id, email, is_active, is_super_admin
        from users
       where lower(email) = ${email}
    `));
    const active = candidates.rows.filter((row) => row.is_active);
    if (active.length === 0) {
      const state =
        candidates.rows.length > 0 ? "exists but is inactive" : "does not exist";
      const remedy =
        candidates.rows.length > 0
          ? "reactivate that user"
          : "set PLATFORM_ADMIN_EMAIL to the seeded administrator (ADMIN_EMAIL) or create the user first";
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL names ${configured}, but that user ${state}; ` +
          `${remedy}, then re-run bootstrap`,
      );
    }
    if (active.length > 1) {
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL names ${configured}, but that address belongs to ` +
          `${active.length} active users in different organizations; keep exactly one active user ` +
          `with that address, then re-run bootstrap`,
      );
    }
    const target = active[0]!;
    const promoted = (await tx.execute<{ id: string }>(sql`
      update users
         set is_super_admin = true, updated_at = now(), updated_by = ${target.id}
       where id = ${target.id} and not is_super_admin and is_active
         and not exists (select 1 from users where is_super_admin and is_active)
      returning id
    `));
    if (promoted.rows.length === 0) {
      // A concurrent bootstrap granted first: the no-op condition now holds,
      // so this is the benign lost race rather than a dropped write.
      const raced = (await tx.execute<{ id: string }>(sql`
        select id from users where is_super_admin and is_active limit 1
      `));
      if (raced.rows.length > 0) return false;
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL grant for ${configured} affected no rows; re-run bootstrap`,
      );
    }
    const audit = (await tx.execute<{ id: string }>(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (
        ${target.org_id},
        'users',
        ${target.id},
        'update',
        ${JSON.stringify({
          source: "bootstrap",
          reason: `Granted platform super-admin access on first bootstrap via PLATFORM_ADMIN_EMAIL (${configured})`,
          before: { is_super_admin: false },
          after: { is_super_admin: true },
        })}::jsonb,
        ${target.id}
      )
      returning id
    `));
    if (audit.rows.length !== 1) {
      throw new Error(
        `[bootstrap] PLATFORM_ADMIN_EMAIL grant for ${configured} was not audited; re-run bootstrap`,
      );
    }
    return true;
  });
  if (granted) {
    console.log(
      `[bootstrap] ${configured} granted platform super-admin via PLATFORM_ADMIN_EMAIL (no active super administrator existed)`,
    );
  }
}
