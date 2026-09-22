/** Custom-record-type import/export resources. */

import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { canonicalDecimal } from '@openbooks/engine/src/money/exact-decimal.ts'
import { decimalNullRefusal } from '@openbooks/engine/src/money/decimal-refusal.ts'
import { allocateDocumentNumber } from '@openbooks/engine/src/records/numbering.ts'
import type { FieldType, FormField, FormSection } from '@openbooks/forms-core'
import type { FieldValueMap } from '@openbooks/forms-core'
import { loadRecordTypeByKey, buildSearchText } from '../records'
import { lintRecordFields, recordNumberPrefix, stripUnknownData, validateRecordData, withComputedFormulas } from '../record-schema'
import { auditSetupChange } from '../setup/audit'
import {
  enforceExportRowLimit,
  exportCell,
  MAX_EXPORT_ROWS,
  RefResolver,
  type DataResource,
  type ReadCtx,
  type WriteCtx,
} from './resource-core'
import { pgTextArrayLiteral } from '../pg-array'
import { parseImportJson } from './import-parse'
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

// Form numeric fields store JSON numbers. Render that representation without
// grouping/exponents before comparing it with the original decimal text.
const recordNumberText = new Intl.NumberFormat('en-US', {
  useGrouping: false,
  maximumSignificantDigits: 21,
})

function importRecordFieldValue(field: FormField, value: unknown): unknown {
  if (
    ['number', 'currency', 'percentage', 'rating'].includes(field.type) &&
    typeof value === 'string' && value.trim() !== ''
  ) {
    const raw = value.trim()
    const numeric = Number(raw)
    // String(number) is also the vocabulary emitted by CSV/JSON exports,
    // including scientific notation for very small schema-owned numbers.
    if (Number.isFinite(numeric) && String(numeric) === raw) return numeric
    const exact = canonicalDecimal(raw, raw.length)
    if (exact === null) throw new Error(decimalNullRefusal(field.label, 'a number', raw, raw.length))
    const stored = Number.isFinite(numeric)
      ? canonicalDecimal(recordNumberText.format(numeric), raw.length)
      : null
    if (stored !== exact) {
      throw new Error(`${field.label}: "${raw}" cannot be stored as a numeric field without changing its value — preserve the original in a text field or explicitly correct its precision before importing`)
    }
    return numeric
  }
  if (
    (field.type === 'text' || field.type === 'long_text' ||
      field.type === 'select' || field.type === 'radio') &&
    typeof value === 'number'
  ) return String(value)
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
    async read(readCtx?: ReadCtx) {
      const fields = recordResourceFields(sections)
      const resolver = new RefResolver(orgId)
      const subsidiaryField = sections.some((section) =>
        section.fields.some((field) => field.id === 'subsidiary_id'),
      )
      const subsidiaryScope =
        !subsidiaryField || readCtx?.allowedSubsidiaryIds === null || readCtx?.allowedSubsidiaryIds === undefined
          ? sql``
          : readCtx.allowedSubsidiaryIds.size > 0
            ? sql`and data ->> ${'subsidiary_id'} = any(${pgTextArrayLiteral([...readCtx.allowedSubsidiaryIds])}::text[])`
            : sql`and false`
      const result = (await db.execute(sql`
        select record_number, status, data from custom_records
         where org_id = ${orgId} and type_key = ${typeKey}
           ${subsidiaryScope}
         order by record_number limit ${MAX_EXPORT_ROWS + 1}`)) as {
        rows: { record_number: string; status: string; data: FieldValueMap }[]
      }
      // Sentinel read: one row past the cap proves overflow; exactly at the
      // cap proves completeness. Refuse rather than truncate silently.
      enforceExportRowLimit(result.rows, descriptor.label)
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
  const repeatingFields = new Map(
    sections.filter((s) => s.repeating).map((s) => [s.id, s.fields] as const),
  )

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
      for (const [sid, rowFields] of repeatingFields) {
        const raw = src[sid]
        if (raw === undefined || raw === null || raw === '') continue
        let parsed: unknown
        try {
          parsed = typeof raw === 'string' ? parseImportJson(raw) : raw
        } catch {
          err = `${sid}: invalid sublist JSON`
          continue
        }
        // Row-level pickers resolve through the same org-scoped resolver as
        // header fields: row JSON carries raw stored values (uuids), and the
        // shape check below only verifies UUID syntax, never ownership — an
        // unresolved row reference must fail the row, never persist blind.
        if (Array.isArray(parsed)) {
          for (const row of parsed) {
            if (!row || typeof row !== 'object' || Array.isArray(row)) continue
            for (const f of rowFields) {
              const cell = (row as FieldValueMap)[f.id]
              if (cell === undefined || cell === null || cell === '') continue
              if (f.type !== 'gl_account' && f.type !== 'party') {
                ;(row as FieldValueMap)[f.id] = importRecordFieldValue(f, cell)
                continue
              }
              const target: ResourceRefTarget =
                f.type === 'gl_account'
                  ? { resource: 'accounts', by: 'number' }
                  : { resource: 'parties', by: 'short_code' }
              const id = await resolver.resolveId(target, cell)
              if (!id) {
                err = `${f.label}: "${String(cell)}" not found`
                break
              }
              ;(row as FieldValueMap)[f.id] = id
            }
            if (err) break
          }
        }
        data[sid] = parsed as FieldValueMap[string]
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
      let before: Record<string, unknown> | null = null
      if (recNo) {
        const found = (await db.execute(sql`
          select * from custom_records
           where org_id = ${orgId} and type_key = ${typeKey} and record_number = ${recNo} limit 1`)) as {
          rows: Record<string, unknown>[]
        }
        before = (found.rows[0] ?? null) as Record<string, unknown> | null
      }
      const existingId = before !== null ? String(before.id) : null
      if (existingId && mode === 'insert') {
        outcome.failed++
        outcome.errors.push({ row: rowNo, message: `already exists (record_number=${recNo})` })
        continue
      }

      const searchText = await buildSearchText(sections, computed, recNo || '')
      if (existingId) {
        if (!ctx.dryRun) {
          // Bulk rows carry no revision token, so imports cannot join the
          // compare-and-swap; they still advance the revision monotonically,
          // so any concurrent drawer or API tab fails closed (409) on its
          // next save instead of silently winning or losing. The overwrite is
          // evidenced per row (same source:'import' shape as the setup import
          // resource) alongside the import_jobs run row.
          const written = (await db.execute(sql`
            update custom_records
               set data = ${JSON.stringify(computed)}::jsonb, search_text = ${searchText},
                   status = 'active',
                   updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond')
             where id = ${existingId} and org_id = ${orgId}
             returning *`)) as { rows: Record<string, unknown>[] }
          const after = written.rows[0]
          if (!after) throw new Error('imported record disappeared during update')
          await auditSetupChange({
            orgId,
            table: 'custom_records',
            rowId: existingId,
            action: 'update',
            changes: { source: 'import', before, after },
            actorId: ctx.actorId,
          })
        }
        outcome.updated++
      } else {
        if (!ctx.dryRun) {
          const number = recNo || (await allocateRecordNumber(orgId, typeKey))
          const inserted = (await db.execute(sql`
            insert into custom_records (org_id, type_id, type_key, record_number, data, search_text, status, created_by)
            values (${orgId}, ${type.id}, ${typeKey}, ${number}, ${JSON.stringify(computed)}::jsonb,
                    ${searchText}, 'active', ${ctx.actorId})
            returning *`)) as { rows: Record<string, unknown>[] }
          const after = inserted.rows[0]
          if (!after) throw new Error('imported record did not return a row')
          await auditSetupChange({
            orgId,
            table: 'custom_records',
            rowId: String(after.id),
            action: 'insert',
            changes: { source: 'import', before: null, after },
            actorId: ctx.actorId,
          })
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
 * canonical allocator (engine/src/records/numbering.ts), which seeds the
 * org-wide `custrec:<typeKey>` sequence row on first use with the same
 * `recordNumberPrefix` stem the UI draft route uses.
 */
async function allocateRecordNumber(orgId: string, typeKey: string): Promise<string> {
  return allocateDocumentNumber(db, orgId, `custrec:${typeKey}`, recordNumberPrefix(typeKey))
}
