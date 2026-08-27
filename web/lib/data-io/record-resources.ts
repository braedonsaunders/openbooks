/** Custom-record-type import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/document-numbering.ts'
import type { FieldType, FormField, FormSection } from '@openbooks/forms-core'
import type { FieldValueMap } from '@openbooks/forms-core'
import { loadRecordTypeByKey, buildSearchText } from '../records'
import { lintRecordFields, recordNumberPrefix, stripUnknownData, validateRecordData, withComputedFormulas } from '../record-schema'
import {
  exportCell,
  MAX_EXPORT_ROWS,
  RefResolver,
  type DataResource,
  type WriteCtx,
} from './resource-core'
import {
  type CellValue,
  type ImportMode,
  type ResourceDescriptor,
  type ResourceField,
  type ResourceRefTarget,
  type WriteOutcome,
} from './types'
// --- Custom-record resources --------------------------------------------------

const RECORD_KIND_MAP: Record<FieldType, ResourceField['kind']> = {
  text: 'text',
  long_text: 'long_text',
  number: 'number',
  currency: 'currency',
  percentage: 'percent',
  select: 'select',
  multi_select: 'multiselect',
  radio: 'select',
  date: 'date',
  datetime: 'datetime',
  rating: 'number',
  formula: 'number',
  gl_account: 'reference',
  party: 'reference',
  // Types the record builder rejects, but the map must be total:
  signature: 'text',
  file: 'text',
}

function recordFieldToResource(f: FormField, sectionId?: string): ResourceField {
  const kind = RECORD_KIND_MAP[f.type]
  const ref: ResourceRefTarget | undefined =
    f.type === 'gl_account'
      ? { resource: 'accounts', by: 'number' }
      : f.type === 'party'
        ? { resource: 'parties', by: 'short_code' }
        : undefined
  return {
    key: f.id,
    label: f.label,
    kind,
    required: f.required,
    options: f.validation?.options?.map((o) => ({ value: o.value, label: o.label })),
    ref,
    section: sectionId,
    readOnly: f.type === 'formula',
  }
}

function recordResourceFields(sections: FormSection[]): ResourceField[] {
  const out: ResourceField[] = []
  for (const s of sections) {
    for (const f of s.fields) out.push(recordFieldToResource(f, s.repeating ? s.id : undefined))
  }
  return out
}

function recordColumns(sections: FormSection[]): { key: string; label: string }[] {
  return [
    { key: 'record_number', label: 'record_number' },
    { key: 'status', label: 'status' },
    ...sections.flatMap((s) =>
      s.repeating
        ? [{ key: s.id, label: s.title || s.id }]
        : s.fields.map((f) => ({ key: f.id, label: f.label })),
    ),
  ]
}

/**
 * XLSX keeps numeric cells numeric so exact-money resources can reject values
 * that already crossed IEEE-754. Custom-record text fields, however, have a
 * schema-owned string representation and historically accept numeric-looking
 * identifiers and choice values from spreadsheets. Restore that display value
 * only after the record field type is known; numeric and currency fields
 * remain numbers.
 */
function importRecordFieldValue(field: FormField, value: unknown): unknown {
  if (
    (field.type === 'text' ||
      field.type === 'long_text' ||
      field.type === 'select' ||
      field.type === 'radio') &&
    typeof value === 'number'
  ) {
    return String(value)
  }
  return value
}

export async function recordSections(orgId: string, typeKey: string): Promise<FormSection[] | null> {
  const type = await loadRecordTypeByKey(orgId, typeKey)
  if (!type || type.status !== 'published') return null
  const linted = lintRecordFields(type.fields, type.name)
  return linted.success ? linted.sections : null
}

export function recordResource(orgId: string, typeKey: string, sections: FormSection[], label: string): DataResource {
  const descriptor: ResourceDescriptor = {
    key: `record:${typeKey}`,
    label,
    group: 'Records',
    iconKey: 'clipboard-list',
    readPermission: 'records.read',
    writePermission: 'records.create',
    supportsImport: true,
    naturalKey: 'record_number',
  }
  return {
    descriptor,
    async fields() {
      return recordResourceFields(sections)
    },
    async columns() {
      return recordColumns(sections)
    },
    async read() {
      const fields = recordResourceFields(sections)
      const resolver = new RefResolver(orgId)
      const result = (await db.execute(sql`
        select record_number, status, data from custom_records
         where org_id = ${orgId} and type_key = ${typeKey}
         order by record_number limit ${MAX_EXPORT_ROWS}`)) as {
        rows: { record_number: string; status: string; data: FieldValueMap }[]
      }
      const out: Record<string, CellValue>[] = []
      for (const rec of result.rows) {
        const row: Record<string, CellValue> = { record_number: rec.record_number, status: rec.status }
        const data = rec.data ?? {}
        for (const s of sections) {
          if (s.repeating) {
            row[s.id] = Array.isArray(data[s.id]) ? JSON.stringify(data[s.id]) : null
          } else {
            for (const f of s.fields) {
              const rf = recordFieldToResource(f)
              row[f.id] = await exportCell(rf, data[f.id], resolver)
            }
          }
        }
        out.push(row)
      }
      return { fields, columns: recordColumns(sections), rows: out }
    },
    async write(rows, mode, ctx) {
      return writeRecords(orgId, typeKey, sections, rows, mode, ctx)
    },
  }
}

async function writeRecords(
  orgId: string,
  typeKey: string,
  sections: FormSection[],
  rows: Record<string, unknown>[],
  mode: ImportMode,
  ctx: WriteCtx,
): Promise<WriteOutcome> {
  const resolver = new RefResolver(orgId)
  const outcome: WriteOutcome = { created: 0, updated: 0, failed: 0, errors: [] }
  const type = await loadRecordTypeByKey(orgId, typeKey)
  if (!type) {
    return { created: 0, updated: 0, failed: rows.length, errors: [{ row: 0, message: 'record type not found' }] }
  }
  const headerFieldList = sections.filter((s) => !s.repeating).flatMap((s) => s.fields)
  const repeatingIds = new Set(sections.filter((s) => s.repeating).map((s) => s.id))

  for (let i = 0; i < rows.length; i++) {
    const rowNo = i + 1
    const src = rows[i]!
    try {
      // Assemble the record `data` map from the flat/nested row.
      const data: FieldValueMap = {}
      let err: string | null = null
      for (const f of headerFieldList) {
        const raw = src[f.id]
        if (raw === undefined || raw === null || raw === '') continue
        if (f.type === 'gl_account' || f.type === 'party') {
          const target: ResourceRefTarget =
            f.type === 'gl_account' ? { resource: 'accounts', by: 'number' } : { resource: 'parties', by: 'short_code' }
          const id = await resolver.resolveId(target, raw)
          if (!id) {
            err = `${f.label}: "${String(raw)}" not found`
            break
          }
          data[f.id] = id
        } else {
          data[f.id] = importRecordFieldValue(f, raw)
        }
      }
      if (err) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: err })
        continue
      }
      // Repeating sections come through as JSON (string or array) for full-fidelity JSON import.
      for (const sid of repeatingIds) {
        const raw = src[sid]
        if (raw === undefined || raw === null || raw === '') continue
        try {
          data[sid] = typeof raw === 'string' ? JSON.parse(raw) : raw
        } catch {
          err = `${sid}: invalid sublist JSON`
        }
      }
      if (err) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: err })
        continue
      }

      const stripped = stripUnknownData(sections, data)
      const computed = withComputedFormulas(sections, stripped)
      const issues = validateRecordData(sections, computed, 'submit')
      if (issues.length > 0) {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: issues.map((x) => x.message).join('; ') })
        continue
      }

      // Match by record_number when supplied.
      const recNo = String(src.record_number ?? '').trim()
      let existingId: string | null = null
      if (recNo) {
        const found = (await db.execute(sql`
          select id from custom_records
           where org_id = ${orgId} and type_key = ${typeKey} and record_number = ${recNo} limit 1`)) as {
          rows: { id: string }[]
        }
        existingId = found.rows[0]?.id ?? null
      }
      if (existingId && mode === 'insert') {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `already exists (record_number=${recNo})` })
        continue
      }

      const searchText = await buildSearchText(sections, computed, recNo || '')
      if (existingId) {
        if (!ctx.dryRun) {
          await db.execute(sql`
            update custom_records
               set data = ${JSON.stringify(computed)}::jsonb, search_text = ${searchText},
                   status = 'active', updated_at = now()
             where id = ${existingId} and org_id = ${orgId}`)
        }
        outcome.updated++
      } else {
        if (!ctx.dryRun) {
          const number = recNo || (await allocateRecordNumber(orgId, typeKey))
          await db.execute(sql`
            insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, status, created_by)
            values (${orgId}, ${type.id}, ${typeKey}, ${number}, ${JSON.stringify(computed)}::jsonb,
                    ${searchText}, 'active', ${ctx.actorId})`)
        }
        outcome.created++
      }
    } catch (e) {
      outcome.failed++
      outcome.errors.push({ row: rowNo, message: (e as { message?: string })?.message ?? 'write failed' })
    }
  }
  return outcome
}

/**
 * Record number when the file omits one (bulk create) — delegated to the ONE
 * canonical allocator (engine/src/document-numbering.ts), which seeds the
 * org-wide `custrec:<typeKey>` sequence row on first use with the same
 * `recordNumberPrefix` stem the UI draft route uses.
 */
async function allocateRecordNumber(orgId: string, typeKey: string): Promise<string> {
  return allocateDocumentNumber(db, orgId, `custrec:${typeKey}`, recordNumberPrefix(typeKey))
}
