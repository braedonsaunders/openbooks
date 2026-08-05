import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

/**
 * Shared data helpers for the forms API. Route handlers enforce the
 * `admin.customization.manage` permission before loading or changing designs.
 */

export type TemplateRow = {
  id: string
  key: string
  name: string
  category: string | null
  description: string | null
  status: 'draft' | 'published' | 'archived'
  kind: 'form' | 'wizard' | 'checklist' | 'register'
  allowed_roles: string[] | null
}

/** Load one org-scoped template by key. */
export async function getTemplateByKey(
  orgId: string,
  key: string,
): Promise<TemplateRow | undefined> {
  const r = (await db.execute(sql`
    select id, key, name, category, description, status, kind, allowed_roles
      from form_templates
     where org_id = ${orgId} and key = ${key}
  `)) as any
  return r.rows[0]
}

/** Latest published version row for a template (what fillers see). */
export async function getPublishedVersion(orgId: string, templateId: string) {
  const r = (await db.execute(sql`
    select id, version, schema, published_at
      from form_template_versions
     where org_id = ${orgId} and template_id = ${templateId} and published_at is not null
     order by version desc limit 1
  `)) as any
  return r.rows[0] as
    | { id: string; version: number; schema: unknown; published_at: string }
    | undefined
}

/** Latest version row regardless of publish state (what the designer edits). */
export async function getLatestVersion(orgId: string, templateId: string) {
  const r = (await db.execute(sql`
    select id, version, schema, changelog, published_at
      from form_template_versions
     where org_id = ${orgId} and template_id = ${templateId}
     order by version desc limit 1
  `)) as any
  return r.rows[0] as
    | {
        id: string
        version: number
        schema: unknown
        changelog: string | null
        published_at: string | null
      }
    | undefined
}
