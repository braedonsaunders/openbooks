import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { documentRevisionCounterSql, documentRevisionSql } from '@openbooks/engine/src/records/revision.ts'
import type { FieldValueMap, FormField, FormSection } from '@openbooks/forms-core'
import { pgTextArrayLiteral } from './pg-array'
import { formatFieldValue, lintRecordFields, type RecordStatus, type RecordTypeStatus } from './record-schema'

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
   * The stored section-aware form definition. Always validate it through
   * `lintRecordFields` before reading fields.
   */
  fields: unknown
  status: RecordTypeStatus
  show_in_nav: boolean
  allowed_roles: string[] | null
  sort_order: number
  /**
   * Opaque optimistic-concurrency token: the type's canonical updated_at when
   * read (six-digit UTC wire form). Builder saves must send it back as
   * expectedUpdatedAt; a stale or missing token fails closed with a 409.
   */
  updated_at: string
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
  /**
   * Opaque optimistic-concurrency token: the record's canonical revision when
   * read (same six-digit UTC wire form as document revisions — never round it
   * through JavaScript Date). Data-bearing saves must send it back as
   * expectedUpdatedAt; a stale token fails closed with a 409.
   */
  updated_at: string
}

const TYPE_COLUMNS = sql`id, key, name, plural_name, icon_key, description, fields,
       status, show_in_nav, allowed_roles, sort_order,
       ${documentRevisionSql(sql`updated_at`)} as updated_at`

export async function loadRecordTypeByKey(
  orgId: string,
  key: string,
): Promise<RecordTypeRow | undefined> {
  const r = (await db.execute<RecordTypeRow>(sql`
    select ${TYPE_COLUMNS} from custom_record_types
     where org_id = ${orgId} and key = ${key}
  `))
  return r.rows[0]
}

export async function loadRecordTypeById(
  orgId: string,
  id: string,
): Promise<RecordTypeRow | undefined> {
  const r = (await db.execute<RecordTypeRow>(sql`
    select ${TYPE_COLUMNS} from custom_record_types
     where org_id = ${orgId} and id = ${id}
  `))
  return r.rows[0]
}

export async function loadRecord(
  orgId: string,
  typeKey: string,
  id: string,
): Promise<RecordRow | undefined> {
  const r = (await db.execute<RecordRow>(sql`
    select id, type_id, type_key, record_number, data, status, created_at, created_by,
           ${documentRevisionCounterSql(sql`revision_seq`)} as updated_at
      from custom_records
     where org_id = ${orgId} and type_key = ${typeKey} and id = ${id}
  `))
  return r.rows[0]
}

/** Whether a custom-record definition carries the conventional subsidiary field. */
export function hasSubsidiaryField(sections: FormSection[]): boolean {
  return sections.some((section) => section.fields.some((field) => field.id === 'subsidiary_id'))
}

/**
 * Ids of the given types whose linted field definitions declare the
 * conventional subsidiary_id field. Aggregate queries use it to apply the
 * JSON subsidiary fence only where the field exists (a type that fails to
 * lint is treated as field-less, never as scoped).
 */
export function subsidiaryDeclaredTypeIds(
  types: Array<{ id: string; name: string; fields: unknown }>,
): string[] {
  const out: string[] = []
  for (const type of types) {
    const lint = lintRecordFields(type.fields, type.name)
    if (lint.success && hasSubsidiaryField(lint.sections)) out.push(type.id)
  }
  return out
}

/** Fail-closed visibility check for JSON-backed subsidiary values on custom records. */
export function recordSubsidiaryScopeAllows(
  sections: FormSection[],
  data: FieldValueMap,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): boolean {
  if (!hasSubsidiaryField(sections) || allowedSubsidiaryIds === null) return true
  const subsidiaryId = data.subsidiary_id
  return typeof subsidiaryId === 'string' && allowedSubsidiaryIds.has(subsidiaryId)
}

/**
 * Visibility when the live type no longer declares subsidiary_id: honor the
 * JSON value if one is still stored, and keep field-less rows without a
 * subsidiary_id org-visible. Field-present types stay on the existing
 * fail-closed helper. Dropping the field must not unscope stored JSON rows.
 */
export function recordVisibleInSubsidiaryFence(
  sections: FormSection[],
  data: FieldValueMap,
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
): boolean {
  const fence = allowedSubsidiaryIds ?? null
  if (fence === null) return true
  if (hasSubsidiaryField(sections)) {
    return recordSubsidiaryScopeAllows(sections, data, fence)
  }
  const subsidiaryId = data.subsidiary_id
  if (typeof subsidiaryId !== 'string' || subsidiaryId.length === 0) return true
  return fence.has(subsidiaryId)
}

/**
 * Query form of recordVisibleInSubsidiaryFence for custom_records.data.
 * Returns null when the caller is unrestricted (no extra predicate).
 */
export function recordVisibleInSubsidiaryFenceSql(
  allowedSubsidiaryIds: ReadonlySet<string> | null | undefined,
  declaresSubsidiaryField: boolean,
): SQL | null {
  const fence = allowedSubsidiaryIds ?? null
  if (fence === null) return null
  const inFence = sql`data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral([...fence])}::text[])`
  if (declaresSubsidiaryField) {
    return fence.size === 0 ? sql`false` : inFence
  }
  return sql`(
    ${inFence}
    or data ->> ${'subsidiary_id'} is null
    or data ->> ${'subsidiary_id'} = ${''}
  )`
}

/**
 * A type's allowed_roles audience: empty/null ⇒ every records.* holder;
 * non-empty ⇒ listed role keys plus admins (same contract as form
 * templates). Type authoring is records.manage_types regardless.
 */
export function inTypeAudience(
  roleKeys: readonly string[],
  allowedRoles: string[] | null | undefined,
): boolean {
  if (!allowedRoles || allowedRoles.length === 0) return true
  return roleKeys.includes('admin') || roleKeys.some((key) => allowedRoles.includes(key))
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
      ? (db.execute<{ id: string; display_name: string }>(sql`
          select id, display_name from parties
           where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify([...partyIds])}::jsonb))
        `))
      : Promise.resolve({ rows: [] as { id: string; display_name: string }[] }),
    accountIds.size > 0
      ? (db.execute<{ id: string; number: string | null; name: string }>(sql`
          select id, number, name from accounts
           where id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify([...accountIds])}::jsonb))
        `))
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
