import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { FieldValueMap, FormField, FormSection } from '@openbooks/forms-core'
import { formatFieldValue, type RecordStatus, type RecordTypeStatus } from './record-schema'

/**
 * Server helpers for the custom-records subsystem: type/record loaders,
 * audience checks, and the search-text builder the module list ILIKEs
 * against. Field-definition and value validation live in the pure
 * ./record-schema module (shared with the client).
 */

export type RecordTypeRow = {
  id: string
  key: string
  name: string
  plural_name: string
  icon_key: string
  description: string | null
  /**
   * The raw stored definition jsonb — either a FormSection[] (current shape)
   * or a legacy flat FormField[]. Always run it through `lintRecordFields`
   * (which normalizes both) rather than reading it directly.
   */
  fields: unknown
  status: RecordTypeStatus
  show_in_nav: boolean
  allowed_roles: string[] | null
  sort_order: number
}

export type RecordRow = {
  id: string
  type_id: string
  type_key: string
  record_number: string
  data: FieldValueMap
  status: RecordStatus
  created_at: string
  created_by: string | null
  updated_at: string
}

const TYPE_COLUMNS = sql`id, key, name, plural_name, icon_key, description, fields,
       status, show_in_nav, allowed_roles, sort_order`

export async function loadRecordTypeByKey(
  orgId: string,
  key: string,
): Promise<RecordTypeRow | undefined> {
  const r = (await db.execute(sql`
    select ${TYPE_COLUMNS} from custom_record_types
     where org_id = ${orgId} and key = ${key}
  `)) as unknown as { rows: RecordTypeRow[] }
  return r.rows[0]
}

export async function loadRecordTypeById(
  orgId: string,
  id: string,
): Promise<RecordTypeRow | undefined> {
  const r = (await db.execute(sql`
    select ${TYPE_COLUMNS} from custom_record_types
     where org_id = ${orgId} and id = ${id}
  `)) as unknown as { rows: RecordTypeRow[] }
  return r.rows[0]
}

export async function loadRecord(
  orgId: string,
  typeKey: string,
  id: string,
): Promise<RecordRow | undefined> {
  const r = (await db.execute(sql`
    select id, type_id, type_key, record_number, data, status, created_at, created_by, updated_at
      from custom_records
     where org_id = ${orgId} and type_key = ${typeKey} and id = ${id}
  `)) as unknown as { rows: RecordRow[] }
  return r.rows[0]
}

/**
 * A type's allowed_roles audience: empty/null ⇒ every records.* holder;
 * non-empty ⇒ listed role keys plus admins (same contract as form
 * templates). Type authoring is records.manage_types regardless.
 */
export function inTypeAudience(role: string, allowedRoles: string[] | null | undefined): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true
  return role === 'admin' || allowedRoles.includes(role)
}

/**
 * Resolve display labels for every party/gl_account uuid referenced anywhere
 * in the given records' data — header fields AND repeating line-list rows
 * (batched — one query per entity table, only when the type has such fields).
 * Used by the list page's cell formatting and the search-text builder.
 */
export async function resolveEntityLabels(
  sections: FormSection[],
  dataRows: FieldValueMap[],
): Promise<{ parties: Map<string, string>; accounts: Map<string, string> }> {
  const partyIds = new Set<string>()
  const accountIds = new Set<string>()
  const collect = (f: FormField, v: unknown) => {
    if (f.type !== 'party' && f.type !== 'gl_account') return
    if (typeof v !== 'string' || v.length === 0) return
    if (f.type === 'party') partyIds.add(v)
    else accountIds.add(v)
  }
  for (const data of dataRows) {
    for (const section of sections) {
      if (section.repeating) {
        const rows = Array.isArray(data[section.id]) ? (data[section.id] as FieldValueMap[]) : []
        for (const row of rows) for (const f of section.fields) collect(f, row?.[f.id])
      } else {
        for (const f of section.fields) collect(f, data[f.id])
      }
    }
  }
  const [parties, accounts] = await Promise.all([
    partyIds.size > 0
      ? (db.execute(sql`
          select id, display_name from parties
           where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify([...partyIds])}::jsonb))
        `) as unknown as Promise<{ rows: { id: string; display_name: string }[] }>)
      : Promise.resolve({ rows: [] as { id: string; display_name: string }[] }),
    accountIds.size > 0
      ? (db.execute(sql`
          select id, number, name from accounts
           where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify([...accountIds])}::jsonb))
        `) as unknown as Promise<{ rows: { id: string; number: string | null; name: string }[] }>)
      : Promise.resolve({ rows: [] as { id: string; number: string | null; name: string }[] }),
  ])
  return {
    parties: new Map(parties.rows.map((p) => [p.id, p.display_name])),
    accounts: new Map(accounts.rows.map((a) => [a.id, `${a.number ?? ''} ${a.name}`.trim()])),
  }
}

/**
 * Space-joined lowercase haystack for a record: the record number plus every
 * field's display value across header fields AND repeating line-list rows
 * (choice labels, resolved party/account names, raw text/numbers). Recomputed
 * on every save; the module list searches it with a single ILIKE.
 */
export async function buildSearchText(
  sections: FormSection[],
  data: FieldValueMap,
  recordNumber: string,
): Promise<string> {
  const labels = await resolveEntityLabels(sections, [data])
  const parts: string[] = [recordNumber]
  for (const section of sections) {
    if (section.repeating) {
      const rows = Array.isArray(data[section.id]) ? (data[section.id] as FieldValueMap[]) : []
      for (const row of rows) {
        for (const f of section.fields) {
          const text = formatFieldValue(f, row?.[f.id], labels)
          if (text) parts.push(text)
        }
      }
    } else {
      for (const f of section.fields) {
        const text = formatFieldValue(f, data[f.id], labels)
        if (text) parts.push(text)
      }
    }
  }
  return parts.join(' ').toLowerCase().slice(0, 10_000)
}
