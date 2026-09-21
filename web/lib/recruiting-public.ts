import { sql } from 'drizzle-orm'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'

/**
 * Public recruiting helpers (HR-18): org resolution for the sessionless
 * career, booking, and signing pages. Every lookup runs under bypass (the
 * email-action route precedent) because public routes carry no request-org
 * RLS scope — the HMAC token (or the public posting id) is the grant, and
 * the row carries its org. Feature checks run after, in the page, so a
 * switched-off surface 404s instead of rendering.
 */

/** Resolve the org behind one interview or offer row. Null = no such row. */
export async function resolvePublicOrgFeatures(
  rowId: string,
  table: 'interview' | 'offer',
): Promise<{ orgId: string } | null> {
  return withBypassContext(async () => {
    const found =
      table === 'interview'
        ? (
            await db.execute<{ orgId: string }>(sql`
              select org_id as "orgId" from hrm_interviews where id = ${rowId}
            `)
          ).rows[0]
        : (
            await db.execute<{ orgId: string }>(sql`
              select org_id as "orgId" from hrm_offers where id = ${rowId}
            `)
          ).rows[0]
    return found ?? null
  })
}

/** URL-safe org slug: the org name lowercased, runs of other chars to one hyphen. */
export function orgSlugFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Resolve an org by its career slug. Exactly one match opens the page;
 * zero or ambiguous slugs 404 — a slug must name its org, never guess it.
 */
export async function resolveOrgBySlug(slug: string): Promise<{ orgId: string; name: string } | null> {
  const orgs = await withBypassContext(async () => {
    const rows = (
      await db.execute<{ orgId: string; name: string }>(sql`
        select id as "orgId", name from orgs
      `)
    ).rows
    return rows
  })
  const matches = orgs.filter((org) => orgSlugFor(org.name) === slug)
  if (matches.length !== 1) return null
  return { orgId: matches[0]!.orgId, name: matches[0]!.name }
}
