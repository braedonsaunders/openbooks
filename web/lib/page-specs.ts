import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { PageSpec } from '@braedonsaunders/appkit-viewspec'
import { validateAgainstRegistries, type SpecRejection } from './page-spec-validate'

/**
 * Tenant-authored page layouts.
 *
 * Every page renders from a loader and a ViewSpec. This is where a tenant's
 * own spec for a route lives, and the reason storing one is safe is the
 * language rather than this file: a spec names blocks and binds fields the
 * page's LOADER already resolved. It carries no conditionals, no arithmetic,
 * no function values, no component references and no capability objects, and
 * its field refs are dot paths guarded against prototype pollution. A stored
 * spec is a layout, not a program, and it cannot reach data its page did not
 * already load.
 *
 * Validation happens TWICE and that is deliberate. Once on the way in, so a
 * malformed document never reaches the table; once on the way out, because
 * the row could have been written by an older build, a restore, or a direct
 * SQL edit, and "it was valid when we stored it" is not a property the
 * renderer can assume. The rules themselves live in `./page-spec-validate`,
 * which has no database and no `server-only`, so every caller shares one
 * answer instead of reimplementing it.
 *
 * Module-projected rows share this table: the installer writes one row per
 * page contribution with `module_version_id` set, and resolution treats those
 * as the weakest stored layer — any tenant layout wins over every module row.
 * The org layer holds exactly ONE active occupant (the partial unique index
 * on active user-null rows says so), so a tenant save, restore, or clear
 * deactivates a competing module projection rather than coexisting with it.
 * The module row survives as an inactive row with an audit entry naming it,
 * which the installer's uninstall (a no-op on an already-inactive row) and
 * rollback (which re-projects) both tolerate.
 */

export interface StoredPageSpec {
  id: string
  route: string
  spec: PageSpec
  note: string | null
  updatedAt: string
  /** The one person this layout is for, or null for the whole org. */
  userId: string | null
}

/**
 * Who a layout is for.
 *
 * `'user'` wins over `'org'` for its owner and changes nothing for anyone
 * else, which is the whole point: someone who wants one panel gone should not
 * have to take it away from their colleagues to get it.
 */
export type LayoutScope = 'org' | 'user'

/**
 * One active `page_specs` row competing to render a route.
 *
 * `module_version_id` is the provenance pointer only the module installer
 * sets: null means someone in this org authored the row, non-null means an
 * installed module version projected it. Tenant writes never SET the pointer
 * (a save may deactivate a module row to replace it, but never claims it).
 */
type PageSpecCandidate = {
  id: string
  spec: unknown
  user_id: string | null
  module_version_id: string | null
  updated_at: string | Date
}

/** Lower wins: the reader's own layout, then the org's, then an installed module. */
function pageSpecRank(row: PageSpecCandidate): number {
  if (row.user_id !== null) return 0
  if (row.module_version_id === null) return 1
  return 2
}

// node-postgres parses timestamptz into a Date; canned rows in tests carry
// ISO strings. Normalize before comparing so both order the same way.
function pageSpecStamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value)
}

/**
 * Which stored row a route renders.
 *
 * Pure so the precedence is checkable without a database: the SQL below
 * fetches every candidate and this decides, which keeps one implementation
 * owning the order instead of splitting it between ORDER BY and code. Ties
 * between module rows — two installed modules claiming one route — break
 * toward the most recently written row, deterministically by id after that;
 * the installer owns refusing or merging such conflicts, this only orders.
 */
function pickPageSpecRow(rows: PageSpecCandidate[]): PageSpecCandidate | null {
  if (rows.length === 0) return null
  const ordered = [...rows].sort(
    (a, b) =>
      pageSpecRank(a) - pageSpecRank(b) ||
      pageSpecStamp(b.updated_at).localeCompare(pageSpecStamp(a.updated_at)) ||
      a.id.localeCompare(b.id),
  )
  return ordered[0] ?? null
}

/**
 * The active override for a route, or null.
 *
 * Precedence is user > org-native > module > built-in (null). The first
 * three are the active `page_specs` rows for the route; the last is this
 * function's null, which is what "renders the built-in page" means.
 * Tenant customization always wins: a personal layout beats the org's, and
 * any tenant layout beats every installed module's.
 *
 * Returns null rather than throwing when the stored document does not
 * validate. A tenant whose saved layout has gone stale — a widget retired, a
 * schema version bumped — gets the built-in page, which is a working page.
 * Refusing to render at all would punish the reader for an author's mistake,
 * and the built-in spec is always a correct answer to "what does this page
 * look like".
 */
export async function loadPageSpec(
  orgId: string,
  route: string,
  registries: { widgets: ReadonlySet<string>; frames: ReadonlySet<string> },
  /** When given, this reader's personal layout is preferred over the org's. */
  userId?: string,
): Promise<{ spec: PageSpec; id: string; scope: LayoutScope; moduleVersionId: string | null } | null> {
  // Every candidate, not just the winner. Two round trips would be a second
  // chance to get the precedence wrong, and LIMIT 1 would split the decision
  // between SQL and `pickPageSpecRow`; the ORDER BY mirrors the picker so a
  // raw look at the rows tells the same story the renderer uses.
  const rows = await db.execute<PageSpecCandidate>(sql`
    select id, spec, user_id, module_version_id, updated_at from page_specs
     where org_id = ${orgId} and route = ${route} and is_active
       and (user_id is null ${userId ? sql`or user_id = ${userId}` : sql``})
     order by user_id nulls last, module_version_id nulls first, updated_at desc, id`)
  const winner = pickPageSpecRow(rows.rows)
  if (!winner) return null

  // Validation gates the WINNER only, as it always has: an invalid winner
  // resolves to null (the built-in renders) rather than promoting a lower
  // layer the tenant did not choose.
  const checked = validateAgainstRegistries(winner.spec, registries)
  if (!checked.ok) {
    console.warn(
      `[page-specs] ignoring stored spec ${winner.id} for ${route}: ${checked.errors.slice(0, 3).join('; ')}`,
    )
    return null
  }
  // A spec stored under one route must not render another. The row's own
  // `route` column is authoritative; a mismatched `spec.route` means the
  // document was copied between routes without being re-pointed.
  if (checked.spec.route && checked.spec.route !== route) {
    console.warn(
      `[page-specs] ignoring stored spec ${winner.id}: declares route ${checked.spec.route}, stored under ${route}`,
    )
    return null
  }
  return {
    spec: checked.spec,
    id: winner.id,
    // A module customizes the org, never one person, so a module row reads as
    // 'org'; `moduleVersionId` carries whose module it is.
    scope: winner.user_id ? 'user' : 'org',
    moduleVersionId: winner.module_version_id,
  }
}

/**
 * Every customized route, for the admin surface.
 *
 * Org layouts, plus this reader's own personal ones — never a colleague's. A
 * personal layout is nobody else's business, and listing them all would turn
 * an admin screen into a window onto what each person has hidden.
 */
export async function listPageSpecs(orgId: string, userId?: string): Promise<StoredPageSpec[]> {
  const rows = await db.execute<{
    id: string
    route: string
    spec: PageSpec
    note: string | null
    updated_at: string
    user_id: string | null
  }>(sql`
    select id, route, spec, note, updated_at, user_id from page_specs
     where org_id = ${orgId} and is_active
       and (user_id is null ${userId ? sql`or user_id = ${userId}` : sql``})
     order by route, user_id nulls first`)
  return rows.rows.map((row) => ({
    id: row.id,
    route: row.route,
    spec: row.spec,
    note: row.note,
    updatedAt: String(row.updated_at),
    userId: row.user_id,
  }))
}

/**
 * Store an override, replacing whatever was active for the route.
 *
 * The previous row is DEACTIVATED rather than deleted, and its deactivation is
 * audited alongside the new row. A tenant turning a customization off should
 * not lose the work; an audit entry that points at a row someone can still
 * read is worth more than one that points at a gap; and a trail that showed
 * two inserts without recording which superseded which would not answer the
 * question anyone opens it to ask.
 */
export async function savePageSpec(opts: {
  orgId: string
  actorId: string
  route: string
  spec: PageSpec
  note?: string | null
  registries: { widgets: ReadonlySet<string>; frames: ReadonlySet<string> }
  /** `'user'` stores it for the actor alone; `'org'` for everyone. */
  scope?: LayoutScope
}): Promise<{ ok: true; id: string } | SpecRejection> {
  const checked = validateAgainstRegistries(opts.spec, opts.registries)
  if (!checked.ok) return checked
  if (checked.spec.route && checked.spec.route !== opts.route) {
    return { ok: false, errors: [`spec declares route ${checked.spec.route}, saved under ${opts.route}`] }
  }

  // The owner of the row being written. A personal save must supersede only
  // the actor's own layout: scoping this wrongly would let one person's
  // preference switch off the layout their whole org is using.
  const owner = opts.scope === 'user' ? opts.actorId : null
  return await db.transaction(async (tx) => {
    // The whole org layer, module projections included. Exactly one active
    // user-null row per route fits (the partial unique index insists), so the
    // new row must DEACTIVATE a competing module projection rather than sit
    // beside it — otherwise the insert below violates the index. The module
    // row survives inactive and the audit names it, so the trail answers why
    // an installed page stopped rendering.
    // The supersession is audited too, not just the new row. Without it the
    // trail shows two inserts for one route and no record of which replaced
    // which — which is the question anyone reading the trail is asking.
    const superseded = await tx.execute<{ id: string; module_version_id: string | null }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${opts.orgId} and route = ${opts.route} and is_active
         and user_id is not distinct from ${owner}
      returning id, module_version_id`)
    for (const row of superseded.rows) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${opts.orgId}, 'page_specs', ${row.id}, 'update',
                ${JSON.stringify({
                  route: opts.route,
                  is_active: false,
                  reason: 'superseded',
                  ...(row.module_version_id ? { moduleVersionId: row.module_version_id } : {}),
                })},
                ${opts.actorId})`)
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into page_specs (org_id, user_id, route, spec, note, created_by, updated_by)
      values (${opts.orgId}, ${owner}, ${opts.route}, ${JSON.stringify(checked.spec)}::jsonb,
              ${opts.note ?? null}, ${opts.actorId}, ${opts.actorId})
      returning id`)
    const id = inserted.rows[0]!.id
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${opts.orgId}, 'page_specs', ${id}, 'insert',
              ${JSON.stringify({ route: opts.route, note: opts.note ?? null, scope: opts.scope ?? 'org' })}, ${opts.actorId})`)
    return { ok: true as const, id }
  })
}

export interface PageSpecVersion {
  id: string
  /** The layout this org renders for the route right now. */
  active: boolean
  note: string | null
  savedAt: string
  /** The user who saved it, if the row recorded one. */
  savedBy: string | null
  authorName: string | null
}

/**
 * Every layout this org has stored for a route, newest first.
 *
 * The rows were always kept — a save deactivates its predecessor rather than
 * deleting it, so the audit trail points at something a person can still
 * read. Nothing could read them, which made "deactivated, not deleted" a
 * promise with no way to collect on it. This is the way.
 */
export async function listPageSpecHistory(orgId: string, route: string): Promise<PageSpecVersion[]> {
  const rows = await db.execute<{
    id: string
    is_active: boolean
    note: string | null
    created_at: string
    created_by: string | null
    author: string | null
  }>(sql`
    select s.id, s.is_active, s.note, s.created_at, s.created_by, u.name as author
      from page_specs s
      left join users u on u.id = s.created_by and u.org_id = s.org_id
     where s.org_id = ${orgId} and s.route = ${route}
     order by s.created_at desc`)
  return rows.rows.map((row) => ({
    id: row.id,
    active: row.is_active,
    note: row.note,
    // `created_at`, not `updated_at`. A superseded row's `updated_at` is when
    // it was switched OFF, so reporting it as "saved" would tell someone
    // reading the history after an incident that two different layouts went
    // live at the same instant.
    savedAt: String(row.created_at),
    savedBy: row.created_by,
    authorName: row.author,
  }))
}

/**
 * Publish a previous version again.
 *
 * Appends a NEW active row carrying the old spec rather than flipping the old
 * row back on. Reactivating in place would make that row's timestamp claim it
 * had been live all along, and the history someone opens after an incident is
 * exactly where that lie would cost the most.
 *
 * Validated under the RENDER rules, not the authoring ones. This is an undo,
 * not an edit: the version being restored was published under the rules of
 * its day and — if it is the one this org was running last week — still
 * renders correctly. Holding it to today's stricter checks would make the
 * layout someone wants back the one they cannot have.
 */
export async function restorePageSpec(opts: {
  orgId: string
  actorId: string
  route: string
  versionId: string
  registries: { widgets: ReadonlySet<string>; frames: ReadonlySet<string> }
}): Promise<{ ok: true; id: string } | SpecRejection> {
  const rows = await db.execute<{ spec: unknown; note: string | null; is_active: boolean }>(sql`
    select spec, note, is_active from page_specs
     where org_id = ${opts.orgId} and route = ${opts.route} and id = ${opts.versionId}
     limit 1`)
  const row = rows.rows[0]
  // Scoped to the org AND the route: a version id is not a capability, and a
  // row from another route would publish a layout under a page it was never
  // written for.
  if (!row) return { ok: false, errors: ['no such version for this route'] }
  if (row.is_active) return { ok: false, errors: ['that version is already the active layout'] }

  const checked = validateAgainstRegistries(row.spec, opts.registries)
  if (!checked.ok) return checked

  return await db.transaction(async (tx) => {
    // The whole active set for the route, module projections included: the
    // restored tenant row must be the single org-layer occupant (see the save
    // path), and the audit below names any module row it replaces.
    const superseded = await tx.execute<{ id: string; module_version_id: string | null }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${opts.orgId} and route = ${opts.route} and is_active
      returning id, module_version_id`)
    for (const previous of superseded.rows) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${opts.orgId}, 'page_specs', ${previous.id}, 'update',
                ${JSON.stringify({
                  route: opts.route,
                  is_active: false,
                  reason: 'superseded',
                  ...(previous.module_version_id ? { moduleVersionId: previous.module_version_id } : {}),
                })},
                ${opts.actorId})`)
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into page_specs (org_id, route, spec, note, created_by, updated_by)
      values (${opts.orgId}, ${opts.route}, ${JSON.stringify(checked.spec)}::jsonb,
              ${row.note}, ${opts.actorId}, ${opts.actorId})
      returning id`)
    const id = inserted.rows[0]!.id
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${opts.orgId}, 'page_specs', ${id}, 'insert',
              ${JSON.stringify({ route: opts.route, restoredFrom: opts.versionId })}, ${opts.actorId})`)
    return { ok: true as const, id }
  })
}

/**
 * How long a preview draft keeps applying.
 *
 * Long enough to edit, look, and come back; short enough that an author who
 * wandered off is not still wearing a layout they have forgotten about. The
 * window is enforced on READ as well as on write, so an expired draft stops
 * applying even if nothing has swept it yet — a draft that outlived its
 * sweep must not quietly keep rendering.
 */
export const DRAFT_TTL_MINUTES = 30

/**
 * Store an author's unpublished layout so they can see it before anyone else.
 *
 * Scoped to one USER, not to the org. A draft is unreviewed work: it must not
 * change what a colleague sees, and it must not become a way to show someone
 * a layout they did not ask for. Publishing stays a separate, audited act.
 *
 * Not audited, deliberately. The audit trail answers "who changed what the
 * org sees", and a draft changes nothing anyone else can observe; filling the
 * trail with keystrokes would bury the entries that do matter.
 */
export async function savePageSpecDraft(opts: {
  orgId: string
  userId: string
  route: string
  spec: PageSpec
  registries: { widgets: ReadonlySet<string>; frames: ReadonlySet<string> }
}): Promise<{ ok: true } | SpecRejection> {
  const checked = validateAgainstRegistries(opts.spec, opts.registries)
  if (!checked.ok) return checked
  if (checked.spec.route && checked.spec.route !== opts.route) {
    return { ok: false, errors: [`spec declares route ${checked.spec.route}, previewed as ${opts.route}`] }
  }

  // Sweep this author's expired drafts on the way past. A background job for
  // a handful of rows per editing session would be machinery without a
  // purpose, and doing it here means the table cannot grow without someone
  // actively using the feature.
  await db.execute(sql`
    delete from page_spec_drafts
     where org_id = ${opts.orgId} and user_id = ${opts.userId}
       and created_at < now() - ${`${DRAFT_TTL_MINUTES} minutes`}::interval`)
  await db.execute(sql`
    insert into page_spec_drafts (org_id, user_id, route, spec)
    values (${opts.orgId}, ${opts.userId}, ${opts.route}, ${JSON.stringify(checked.spec)}::jsonb)
    on conflict (org_id, user_id, route)
    do update set spec = excluded.spec, created_at = now()`)
  return { ok: true as const }
}

/**
 * The caller's own unexpired draft for a route, or null.
 *
 * Validated on the way out for the same reason a stored override is: the row
 * could have been written by an older build, and "it was valid when we stored
 * it" is not a property the renderer can assume.
 */
export async function loadPageSpecDraft(
  orgId: string,
  userId: string,
  route: string,
  registries: { widgets: ReadonlySet<string>; frames: ReadonlySet<string> },
): Promise<PageSpec | null> {
  const rows = await db.execute<{ spec: unknown }>(sql`
    select spec from page_spec_drafts
     where org_id = ${orgId} and user_id = ${userId} and route = ${route}
       and created_at >= now() - ${`${DRAFT_TTL_MINUTES} minutes`}::interval
     limit 1`)
  const row = rows.rows[0]
  if (!row) return null
  const checked = validateAgainstRegistries(row.spec, registries)
  if (!checked.ok) {
    console.warn(`[page-specs] ignoring draft for ${route}: ${checked.errors.slice(0, 3).join('; ')}`)
    return null
  }
  if (checked.spec.route && checked.spec.route !== route) return null
  return checked.spec
}

/** Drop a draft once its author has published or walked away. */
export async function clearPageSpecDraft(orgId: string, userId: string, route: string): Promise<void> {
  await db.execute(sql`
    delete from page_spec_drafts
     where org_id = ${orgId} and user_id = ${userId} and route = ${route}`)
}

/**
 * Turn an override off; the page falls back to its built-in spec.
 *
 * Deactivates the active occupant even when it is a module projection:
 * clearing is the tenant choosing the built-in page over everything stored.
 * The module row survives inactive with an audit entry, as with a save.
 */
export async function clearPageSpec(opts: {
  orgId: string
  actorId: string
  route: string
  scope?: LayoutScope
}): Promise<{ cleared: number }> {
  const owner = opts.scope === 'user' ? opts.actorId : null
  return await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${opts.orgId} and route = ${opts.route} and is_active
         and user_id is not distinct from ${owner}
      returning id`)
    for (const row of rows.rows) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${opts.orgId}, 'page_specs', ${row.id}, 'update',
                ${JSON.stringify({ route: opts.route, is_active: false })}, ${opts.actorId})`)
    }
    return { cleared: rows.rows.length }
  })
}
