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
 */

export interface StoredPageSpec {
  id: string
  route: string
  spec: PageSpec
  note: string | null
  updatedAt: string
}

/**
 * The active override for a route, or null.
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
): Promise<{ spec: PageSpec; id: string } | null> {
  const rows = await db.execute<{ id: string; spec: unknown }>(sql`
    select id, spec from page_specs
     where org_id = ${orgId} and route = ${route} and is_active
     limit 1`)
  const row = rows.rows[0]
  if (!row) return null

  const checked = validateAgainstRegistries(row.spec, registries)
  if (!checked.ok) {
    console.warn(
      `[page-specs] ignoring stored spec ${row.id} for ${route}: ${checked.errors.slice(0, 3).join('; ')}`,
    )
    return null
  }
  // A spec stored under one route must not render another. The row's own
  // `route` column is authoritative; a mismatched `spec.route` means the
  // document was copied between routes without being re-pointed.
  if (checked.spec.route && checked.spec.route !== route) {
    console.warn(
      `[page-specs] ignoring stored spec ${row.id}: declares route ${checked.spec.route}, stored under ${route}`,
    )
    return null
  }
  return { spec: checked.spec, id: row.id }
}

/** Every route this org has customized, for the admin surface. */
export async function listPageSpecs(orgId: string): Promise<StoredPageSpec[]> {
  const rows = await db.execute<{
    id: string
    route: string
    spec: PageSpec
    note: string | null
    updated_at: string
  }>(sql`
    select id, route, spec, note, updated_at from page_specs
     where org_id = ${orgId} and is_active
     order by route`)
  return rows.rows.map((row) => ({
    id: row.id,
    route: row.route,
    spec: row.spec,
    note: row.note,
    updatedAt: String(row.updated_at),
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
}): Promise<{ ok: true; id: string } | SpecRejection> {
  const checked = validateAgainstRegistries(opts.spec, opts.registries)
  if (!checked.ok) return checked
  if (checked.spec.route && checked.spec.route !== opts.route) {
    return { ok: false, errors: [`spec declares route ${checked.spec.route}, saved under ${opts.route}`] }
  }

  return await db.transaction(async (tx) => {
    // The supersession is audited too, not just the new row. Without it the
    // trail shows two inserts for one route and no record of which replaced
    // which — which is the question anyone reading the trail is asking.
    const superseded = await tx.execute<{ id: string }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${opts.orgId} and route = ${opts.route} and is_active
      returning id`)
    for (const row of superseded.rows) {
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${opts.orgId}, 'page_specs', ${row.id}, 'update',
                ${JSON.stringify({ route: opts.route, is_active: false, reason: 'superseded' })},
                ${opts.actorId})`)
    }
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into page_specs (org_id, route, spec, note, created_by, updated_by)
      values (${opts.orgId}, ${opts.route}, ${JSON.stringify(checked.spec)}::jsonb,
              ${opts.note ?? null}, ${opts.actorId}, ${opts.actorId})
      returning id`)
    const id = inserted.rows[0]!.id
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${opts.orgId}, 'page_specs', ${id}, 'insert',
              ${JSON.stringify({ route: opts.route, note: opts.note ?? null })}, ${opts.actorId})`)
    return { ok: true as const, id }
  })
}

/** Turn an override off; the page falls back to its built-in spec. */
export async function clearPageSpec(opts: {
  orgId: string
  actorId: string
  route: string
}): Promise<{ cleared: number }> {
  return await db.transaction(async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      update page_specs set is_active = false, updated_at = now(), updated_by = ${opts.actorId}
       where org_id = ${opts.orgId} and route = ${opts.route} and is_active
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
