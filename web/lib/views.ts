import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  REPORT_ENTITY_MAP,
  defaultRowsQuery,
  validateCustomQuery,
  type ReportCustomQuery,
  type ReportRunLabels,
  type ReportRunResult,
} from '@openbooks/reports'
import { executeReport } from './custom-reports'

/**
 * Views (the source platform Saved Search analogue, Knowledge menu). A view stores a
 * ReportCustomQuery plan — the SAME shape + engine as custom report_definitions
 * — plus owner/scope metadata. Execution reuses executeReport (runCustomQuery
 * over the shared pool), so there is one injection-safe query engine for both
 * reports and views, not two.
 *
 * Visibility: a `private` view is visible only to its owner; a `shared` view is
 * visible org-wide, optionally gated to a set of role keys (allowedRoles —
 * admins bypass). Only the owner (or an admin) may edit/delete.
 */

export type ViewScope = 'private' | 'shared'

export type ViewRow = {
  id: string
  org_id: string
  slug: string
  name: string
  description: string | null
  query: ReportCustomQuery
  layout: Record<string, unknown> | null
  scope: ViewScope
  owner_id: string
  allowed_roles: string[] | null
  created_at: string
  updated_at: string
}

export type ViewVisibility = {
  roleKeys: string[]
  isAdmin: boolean
}

async function userVisibility(orgId: string, userId: string, perms: Set<string>): Promise<ViewVisibility> {
  const isAdmin = perms.has('*')
  let roleKeys: string[] = []
  if (!isAdmin) {
    const r = (await db.execute<{ key: string }>(sql`
      select r.key
        from role_assignments a
        join app_roles r on r.id = a.role_id
       where a.user_id = ${userId} and a.org_id = ${orgId}
    `))
    roleKeys = r.rows.map((x) => x.key)
  }
  return { roleKeys, isAdmin }
}

/**
 * A predicate fragment the list query ANDs in to enforce visibility — fully
 * parameterized (ids and role keys are bound, never inlined).
 */
function visiblePredicate(userId: string, vis: ViewVisibility): SQL {
  // Admins see every shared and private view.
  if (vis.isAdmin) return sql`sv.scope in ('shared', 'private')`
  // allowedRoles gating: a shared view with a non-empty allowed_roles array
  // is visible only to holders of one of those roles (admins bypass).
  // NB: interpolating a JS array into drizzle `sql` EXPANDS it into a value
  // list (empty array → invalid `()`), so the role keys bind as one jsonb
  // param and the overlap test runs in jsonb space.
  const noRoleRestriction = sql`(
    sv.allowed_roles is null
    or jsonb_array_length(coalesce(sv.allowed_roles,'[]'::jsonb)) = 0
  )`
  const allowedClause =
    vis.roleKeys.length === 0
      ? noRoleRestriction
      : sql`(${noRoleRestriction} or exists (
          select 1 from jsonb_array_elements_text(coalesce(sv.allowed_roles,'[]'::jsonb)) k
           where k in (select jsonb_array_elements_text(${JSON.stringify(vis.roleKeys)}::jsonb))
        ))`
  return sql`(sv.scope = 'shared' and ${allowedClause}) or (sv.scope = 'private' and sv.owner_id = ${userId})`
}

export async function loadViews(
  orgId: string,
  userId: string,
  perms: Set<string>,
): Promise<ViewRow[]> {
  const vis = await userVisibility(orgId, userId, perms)
  const r = (await db.execute<ViewRow>(sql`
    select sv.id, sv.org_id, sv.slug, sv.name, sv.description, sv.query, sv.layout,
           sv.scope, sv.owner_id, sv.allowed_roles, sv.created_at, sv.updated_at
      from saved_views sv
     where sv.org_id = ${orgId}
       and (${visiblePredicate(userId, vis)})
     order by sv.updated_at desc
  `))
  return r.rows.map(normalize)
}

export async function loadView(
  orgId: string,
  id: string,
  userId: string,
  perms: Set<string>,
): Promise<ViewRow | null> {
  const vis = await userVisibility(orgId, userId, perms)
  const r = (await db.execute<ViewRow>(sql`
    select sv.id, sv.org_id, sv.slug, sv.name, sv.description, sv.query, sv.layout,
           sv.scope, sv.owner_id, sv.allowed_roles, sv.created_at, sv.updated_at
      from saved_views sv
     where sv.org_id = ${orgId} and sv.id = ${id}
       and (${visiblePredicate(userId, vis)})
     limit 1
  `))
  return r.rows[0] ? normalize(r.rows[0]) : null
}

/** The owner (or an admin) may edit/delete — checked before any mutation. */
async function assertCanMutate(
  orgId: string,
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<boolean> {
  if (isAdmin) return true
  const r = (await db.execute(sql`
    select 1 from saved_views
     where org_id = ${orgId} and id = ${id} and owner_id = ${userId}
     limit 1
  `))
  return r.rows.length > 0
}

export async function createView(args: {
  orgId: string
  userId: string
  name?: string
}): Promise<{ id: string; slug: string }> {
  const name = args.name?.trim() || 'Untitled view'
  const slug = await uniqueViewSlug(args.orgId, slugifyViewName(name))
  const query = defaultRowsQuery(REPORT_ENTITY_MAP.ledger_lines!)
  const r = (await db.execute<{ id: string; slug: string }>(sql`
    insert into saved_views (org_id, slug, name, query, scope, owner_id, created_by, updated_by)
    values (${args.orgId}, ${slug}, ${name}, ${query as unknown as Record<string, unknown>}, 'private',
            ${args.userId}, ${args.userId}, ${args.userId})
    returning id, slug
  `))
  return r.rows[0]!
}

export async function updateView(
  orgId: string,
  id: string,
  userId: string,
  isAdmin: boolean,
  patch: {
    name?: string
    slug?: string
    description?: string | null
    query?: ReportCustomQuery
    layout?: Record<string, unknown> | null
    scope?: ViewScope
    allowedRoles?: string[] | null
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const canMutate = await assertCanMutate(orgId, id, userId, isAdmin)
  if (!canMutate) return { ok: false, error: 'You can only edit your own views.' }

  const sets: SQL[] = []
  if (patch.name !== undefined) sets.push(sql`name = ${patch.name.trim()}`)
  if (patch.slug !== undefined) sets.push(sql`slug = ${patch.slug}`)
  if (patch.description !== undefined) sets.push(sql`description = ${patch.description}`)
  if (patch.query !== undefined) {
    try {
      const validated = validateCustomQuery(patch.query)
      sets.push(sql`query = ${validated as unknown as Record<string, unknown>}`)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Invalid query' }
    }
  }
  if (patch.layout !== undefined) sets.push(sql`layout = ${patch.layout}`)
  if (patch.scope !== undefined) {
    // The scope drives the visibility predicate — an unexpected value would
    // make the row invisible to everyone (including its owner). Whitelist it.
    if (patch.scope !== 'private' && patch.scope !== 'shared') {
      return { ok: false, error: 'Invalid scope' }
    }
    sets.push(sql`scope = ${patch.scope}`)
  }
  if (patch.allowedRoles !== undefined) {
    // allowed_roles is a jsonb column: bind it as a JSON string (a bare JS
    // array would be serialized by node-postgres as a Postgres array literal,
    // which is invalid jsonb). Whitelist the shape: null or string[].
    if (patch.allowedRoles !== null) {
      if (!Array.isArray(patch.allowedRoles) || patch.allowedRoles.some((r) => typeof r !== 'string')) {
        return { ok: false, error: 'Invalid allowedRoles' }
      }
    }
    sets.push(
      patch.allowedRoles === null
        ? sql`allowed_roles = null`
        : sql`allowed_roles = ${JSON.stringify(patch.allowedRoles)}::jsonb`,
    )
  }
  if (sets.length === 0) return { ok: true }
  sets.push(sql`updated_at = now()`, sql`updated_by = ${userId}`)
  await db.execute(sql`
    update saved_views set ${sql.join(sets, sql`, `)}
     where org_id = ${orgId} and id = ${id}
  `)
  return { ok: true }
}

export async function deleteView(
  orgId: string,
  id: string,
  userId: string,
  isAdmin: boolean,
): Promise<boolean> {
  const canMutate = await assertCanMutate(orgId, id, userId, isAdmin)
  if (!canMutate) return false
  await db.execute(sql`
    delete from saved_views where org_id = ${orgId} and id = ${id}
  `)
  return true
}

/**
 * The permission a view's entity demands beyond reports.read, or null. Saved
 * views read the SAME catalog as custom reports and the insights card studio,
 * so they owe the same gate: a payroll view shared org-wide must not become a
 * wage leak for a reader who lacks payroll.read.
 */
export function viewEntityPermission(query: Pick<ReportCustomQuery, 'entity'>): string | null {
  return REPORT_ENTITY_MAP[query.entity]?.requiredPermission ?? null
}

/** Execute a view's plan (fresh, current data) — the one shared executor. */
export async function runView(
  orgId: string,
  query: ReportCustomQuery,
  maxRows = 10000,
  labels?: ReportRunLabels,
): Promise<ReportRunResult> {
  // Views store the same plan shape as report definitions, so they must go
  // through executeReport too: a `period_preset` window that reached the
  // compiler unresolved would silently drop its date bounds and return every
  // row. This also supplies fiscalStartMonth for fiscal_* breakouts.
  return executeReport(orgId, query, maxRows, labels)
}

export function slugifyViewName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return base || 'view'
}

export async function uniqueViewSlug(orgId: string, desired: string, excludeId?: string): Promise<string> {
  let slug = desired
  for (let n = 2; n < 1000; n++) {
    const clash = (await db.execute(sql`
      select 1 from saved_views
       where org_id = ${orgId} and slug = ${slug}
         ${excludeId ? sql`and id <> ${excludeId}` : sql``}
       limit 1
    `))
    if (clash.rows.length === 0) return slug
    slug = `${desired}-${n}`
  }
  return `${desired}-${Date.now()}`
}

/** Normalize a DB row: the query jsonb comes back validated-shaped. */
function normalize(row: ViewRow): ViewRow {
  return { ...row, query: validateCustomQuery(row.query) }
}
