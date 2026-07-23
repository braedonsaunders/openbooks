import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db, withBypassContext } from "@openbooks/engine/src/db.ts";

export type PlatformSummary = {
  organizations: number;
  productionOrganizations: number;
  environments: number;
  activeUsers: number;
  superAdmins: number;
  activeGrants: number;
  failedEmails: number;
};

export type PlatformOrganization = {
  id: string;
  name: string;
  legalName: string | null;
  baseCurrency: string;
  country: string;
  envKind: "production" | "sandbox" | "preview";
  sandboxOf: string | null;
  parentName: string | null;
  userCount: number;
  activeUserCount: number;
  sandboxCount: number;
  createdAt: string | Date;
};

export type PlatformUser = {
  id: string;
  email: string;
  name: string;
  orgId: string;
  orgName: string;
  role: string;
  isSuperAdmin: boolean;
  isActive: boolean;
  lastLoginAt: string | Date | null;
  grantCount: number;
  createdAt: string | Date;
};

export type PlatformGrant = {
  id: string;
  memberUserId: string;
  memberEmail: string;
  memberName: string;
  memberOrgName: string;
  orgId: string;
  orgName: string;
  actingUserId: string;
  actingEmail: string;
  actingName: string;
  isActive: boolean;
  createdAt: string | Date;
  updatedAt: string | Date;
};

export type PlatformEmail = {
  id: string;
  orgId: string;
  orgName: string;
  recipientPrimary: string | null;
  recipients: string[];
  subject: string;
  provider: string | null;
  status: "queued" | "sent" | "failed" | "suppressed";
  categoryKey: string | null;
  errorMessage: string | null;
  sentAt: string | Date | null;
  createdAt: string | Date;
};

type ListInput = {
  q?: string;
  page: number;
  perPage: number;
  dir: "asc" | "desc";
};

function searchClause(q: string | undefined, columns: SQL[]): SQL {
  if (!q) return sql`true`;
  const term = `%${q}%`;
  return sql`(${sql.join(
    columns.map((column) => sql`${column} ilike ${term}`),
    sql` or `,
  )})`;
}

function direction(dir: "asc" | "desc"): SQL {
  return dir === "asc" ? sql`asc` : sql`desc`;
}

export async function platformSummary(): Promise<PlatformSummary> {
  return withBypassContext(async () => {
    const result = (await db.execute(sql`
      select
        (select count(*) from orgs)::int as "organizations",
        (select count(*) from orgs where env_kind = 'production')::int as "productionOrganizations",
        (select count(*) from orgs where env_kind <> 'production')::int as "environments",
        (select count(*) from users where is_active)::int as "activeUsers",
        (select count(*) from users where is_super_admin and is_active)::int as "superAdmins",
        (select count(*) from user_org_access where is_active)::int as "activeGrants",
        (select count(*) from email_log where status = 'failed')::int as "failedEmails"
    `)) as { rows: PlatformSummary[] };
    return (
      result.rows[0] ?? {
        organizations: 0,
        productionOrganizations: 0,
        environments: 0,
        activeUsers: 0,
        superAdmins: 0,
        activeGrants: 0,
        failedEmails: 0,
      }
    );
  });
}

export async function platformOrganizations(
  input: ListInput & {
    sort: "name" | "environment" | "users" | "sandboxes" | "created";
    environment?: "production" | "sandbox" | "preview";
  },
): Promise<{
  rows: PlatformOrganization[];
  total: number;
  environmentCounts: Record<string, number>;
}> {
  return withBypassContext(async () => {
    const search = searchClause(input.q, [
      sql`o.name`,
      sql`o.legal_name`,
      sql`o.country`,
      sql`o.base_currency`,
    ]);
    const environment = input.environment
      ? sql`and o.env_kind = ${input.environment}`
      : sql``;
    const dir = direction(input.dir);
    const order =
      input.sort === "environment"
        ? sql`o.env_kind ${dir}, o.name asc`
        : input.sort === "users"
          ? sql`"userCount" ${dir}, o.name asc`
          : input.sort === "sandboxes"
            ? sql`"sandboxCount" ${dir}, o.name asc`
            : input.sort === "created"
              ? sql`o.created_at ${dir}, o.name asc`
              : sql`o.name ${dir}`;
    const offset = (input.page - 1) * input.perPage;
    const [rowsResult, totalResult, countsResult] = await Promise.all([
      db.execute(sql`
        select o.id, o.name, o.legal_name as "legalName", o.base_currency as "baseCurrency",
               o.country, o.env_kind as "envKind", o.sandbox_of as "sandboxOf",
               parent.name as "parentName", o.created_at as "createdAt",
               (select count(*) from users u where u.org_id = o.id)::int as "userCount",
               (select count(*) from users u where u.org_id = o.id and u.is_active)::int as "activeUserCount",
               (select count(*) from orgs child where child.sandbox_of = o.id)::int as "sandboxCount"
          from orgs o
          left join orgs parent on parent.id = o.sandbox_of
         where ${search} ${environment}
         order by ${order}
         limit ${input.perPage} offset ${offset}
      `),
      db.execute(
        sql`select count(*)::int as total from orgs o where ${search} ${environment}`,
      ),
      db.execute(
        sql`select env_kind as kind, count(*)::int as count from orgs group by env_kind`,
      ),
    ]);
    return {
      rows: rowsResult.rows as unknown as PlatformOrganization[],
      total: Number(
        (totalResult.rows[0] as { total?: number } | undefined)?.total ?? 0,
      ),
      environmentCounts: Object.fromEntries(
        (countsResult.rows as unknown as { kind: string; count: number }[]).map(
          (row) => [row.kind, Number(row.count)],
        ),
      ),
    };
  });
}

export async function platformUsers(
  input: ListInput & {
    sort: "name" | "email" | "organization" | "role" | "lastLogin" | "grants";
    status?: "active" | "inactive" | "super";
  },
): Promise<{
  rows: PlatformUser[];
  total: number;
  statusCounts: Record<string, number>;
}> {
  return withBypassContext(async () => {
    const search = searchClause(input.q, [
      sql`u.name`,
      sql`u.email`,
      sql`o.name`,
      sql`u.role`,
    ]);
    const status =
      input.status === "active"
        ? sql`and u.is_active`
        : input.status === "inactive"
          ? sql`and not u.is_active`
          : input.status === "super"
            ? sql`and u.is_super_admin`
            : sql``;
    const dir = direction(input.dir);
    const order =
      input.sort === "email"
        ? sql`u.email ${dir}`
        : input.sort === "organization"
          ? sql`o.name ${dir}, u.name asc`
          : input.sort === "role"
            ? sql`u.role ${dir}, u.name asc`
            : input.sort === "lastLogin"
              ? sql`u.last_login_at ${dir} nulls last, u.name asc`
              : input.sort === "grants"
                ? sql`"grantCount" ${dir}, u.name asc`
                : sql`u.name ${dir}, u.email asc`;
    const offset = (input.page - 1) * input.perPage;
    const [rowsResult, totalResult, countsResult] = await Promise.all([
      db.execute(sql`
        select u.id, u.email, u.name, u.org_id as "orgId", o.name as "orgName", u.role,
               u.is_super_admin as "isSuperAdmin", u.is_active as "isActive",
               u.last_login_at as "lastLoginAt", u.created_at as "createdAt",
               (select count(*) from user_org_access a where a.member_user_id = u.id and a.is_active)::int as "grantCount"
          from users u join orgs o on o.id = u.org_id
         where o.env_kind = 'production' and ${search} ${status}
         order by ${order}
         limit ${input.perPage} offset ${offset}
      `),
      db.execute(sql`
        select count(*)::int as total
          from users u join orgs o on o.id = u.org_id
         where o.env_kind = 'production' and ${search} ${status}
      `),
      db.execute(sql`
        select
          count(*) filter (where u.is_active)::int as active,
          count(*) filter (where not u.is_active)::int as inactive,
          count(*) filter (where u.is_super_admin)::int as super
          from users u join orgs o on o.id = u.org_id
         where o.env_kind = 'production'
      `),
    ]);
    const counts = countsResult.rows[0] as Record<string, number> | undefined;
    return {
      rows: rowsResult.rows as unknown as PlatformUser[],
      total: Number(
        (totalResult.rows[0] as { total?: number } | undefined)?.total ?? 0,
      ),
      statusCounts: {
        active: Number(counts?.active ?? 0),
        inactive: Number(counts?.inactive ?? 0),
        super: Number(counts?.super ?? 0),
      },
    };
  });
}

export async function platformGrants(
  input: ListInput & {
    sort: "member" | "organization" | "actingUser" | "updated";
    status?: "active" | "inactive";
  },
): Promise<{
  rows: PlatformGrant[];
  total: number;
  statusCounts: Record<string, number>;
}> {
  return withBypassContext(async () => {
    const search = searchClause(input.q, [
      sql`m.email`,
      sql`m.name`,
      sql`mo.name`,
      sql`o.name`,
      sql`au.email`,
      sql`au.name`,
    ]);
    const status =
      input.status === "active"
        ? sql`and a.is_active`
        : input.status === "inactive"
          ? sql`and not a.is_active`
          : sql``;
    const dir = direction(input.dir);
    const order =
      input.sort === "organization"
        ? sql`o.name ${dir}, m.email asc`
        : input.sort === "actingUser"
          ? sql`au.email ${dir}, m.email asc`
          : input.sort === "updated"
            ? sql`a.updated_at ${dir}`
            : sql`m.email ${dir}, o.name asc`;
    const from = sql`
      from user_org_access a
      join users m on m.id = a.member_user_id
      join orgs mo on mo.id = m.org_id
      join orgs o on o.id = a.org_id
      join users au on au.id = a.acting_user_id
    `;
    const offset = (input.page - 1) * input.perPage;
    const [rowsResult, totalResult, countsResult] = await Promise.all([
      db.execute(sql`
        select a.id, a.member_user_id as "memberUserId", m.email as "memberEmail", m.name as "memberName",
               mo.name as "memberOrgName", a.org_id as "orgId", o.name as "orgName",
               a.acting_user_id as "actingUserId", au.email as "actingEmail", au.name as "actingName",
               a.is_active as "isActive", a.created_at as "createdAt", a.updated_at as "updatedAt"
        ${from}
        where ${search} ${status}
        order by ${order}
        limit ${input.perPage} offset ${offset}
      `),
      db.execute(
        sql`select count(*)::int as total ${from} where ${search} ${status}`,
      ),
      db.execute(sql`
        select count(*) filter (where is_active)::int as active,
               count(*) filter (where not is_active)::int as inactive
          from user_org_access
      `),
    ]);
    const counts = countsResult.rows[0] as Record<string, number> | undefined;
    return {
      rows: rowsResult.rows as unknown as PlatformGrant[],
      total: Number(
        (totalResult.rows[0] as { total?: number } | undefined)?.total ?? 0,
      ),
      statusCounts: {
        active: Number(counts?.active ?? 0),
        inactive: Number(counts?.inactive ?? 0),
      },
    };
  });
}

export async function platformUser(
  id: string,
): Promise<{ user: PlatformUser; grants: PlatformGrant[] } | null> {
  return withBypassContext(async () => {
    const usersResult = (await db.execute(sql`
      select u.id, u.email, u.name, u.org_id as "orgId", o.name as "orgName", u.role,
             u.is_super_admin as "isSuperAdmin", u.is_active as "isActive",
             u.last_login_at as "lastLoginAt", u.created_at as "createdAt",
             (select count(*) from user_org_access a where a.member_user_id = u.id and a.is_active)::int as "grantCount"
        from users u join orgs o on o.id = u.org_id
       where u.id = ${id}
    `)) as { rows: PlatformUser[] };
    const user = usersResult.rows[0];
    if (!user) return null;
    const grants = await platformGrants({
      q: user.email,
      page: 1,
      perPage: 100,
      dir: "asc",
      sort: "organization",
    });
    return {
      user,
      grants: grants.rows.filter((grant) => grant.memberUserId === id),
    };
  });
}

export async function platformGrantOptions(): Promise<{
  members: Pick<PlatformUser, "id" | "name" | "email" | "orgName" | "orgId">[];
  organizations: Pick<PlatformOrganization, "id" | "name">[];
  actingUsers: Pick<
    PlatformUser,
    "id" | "name" | "email" | "orgName" | "orgId"
  >[];
}> {
  return withBypassContext(async () => {
    const usersResult = await db.execute(sql`
      select u.id, u.name, u.email, u.org_id as "orgId", o.name as "orgName"
        from users u join orgs o on o.id = u.org_id
       where o.env_kind = 'production' and u.is_active
       order by o.name, u.name, u.email
    `);
    const orgsResult = await db.execute(sql`
      select id, name from orgs where env_kind = 'production' order by name
    `);
    const users = usersResult.rows as unknown as Pick<
      PlatformUser,
      "id" | "name" | "email" | "orgName" | "orgId"
    >[];
    return {
      members: users,
      actingUsers: users,
      organizations: orgsResult.rows as unknown as Pick<
        PlatformOrganization,
        "id" | "name"
      >[],
    };
  });
}

export async function platformEmails(
  input: ListInput & {
    sort: "created" | "organization" | "recipient" | "subject" | "status";
    status?: PlatformEmail["status"];
  },
): Promise<{
  rows: PlatformEmail[];
  total: number;
  statusCounts: Record<string, number>;
}> {
  return withBypassContext(async () => {
    const search = searchClause(input.q, [
      sql`e.subject`,
      sql`e.recipient_primary`,
      sql`e.provider`,
      sql`o.name`,
    ]);
    const status = input.status ? sql`and e.status = ${input.status}` : sql``;
    const dir = direction(input.dir);
    const order =
      input.sort === "organization"
        ? sql`o.name ${dir}, e.created_at desc`
        : input.sort === "recipient"
          ? sql`e.recipient_primary ${dir} nulls last`
          : input.sort === "subject"
            ? sql`e.subject ${dir}`
            : input.sort === "status"
              ? sql`e.status ${dir}, e.created_at desc`
              : sql`e.created_at ${dir}`;
    const offset = (input.page - 1) * input.perPage;
    const [rowsResult, totalResult, countsResult] = await Promise.all([
      db.execute(sql`
        select e.id, e.org_id as "orgId", o.name as "orgName", e.recipient_primary as "recipientPrimary",
               e.recipients, e.subject, e.provider, e.status, e.category_key as "categoryKey",
               e.error_message as "errorMessage", e.sent_at as "sentAt", e.created_at as "createdAt"
          from email_log e join orgs o on o.id = e.org_id
         where ${search} ${status}
         order by ${order}
         limit ${input.perPage} offset ${offset}
      `),
      db.execute(sql`
        select count(*)::int as total
          from email_log e join orgs o on o.id = e.org_id
         where ${search} ${status}
      `),
      db.execute(
        sql`select status, count(*)::int as count from email_log group by status`,
      ),
    ]);
    return {
      rows: rowsResult.rows as unknown as PlatformEmail[],
      total: Number(
        (totalResult.rows[0] as { total?: number } | undefined)?.total ?? 0,
      ),
      statusCounts: Object.fromEntries(
        (
          countsResult.rows as unknown as { status: string; count: number }[]
        ).map((row) => [row.status, Number(row.count)]),
      ),
    };
  });
}
