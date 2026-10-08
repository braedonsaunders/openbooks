import 'server-only'
import { guardCsvCell, importTemplateXlsx, type ImportTemplateColumn } from '@openbooks/office'
import type { ResourceField } from './types'

/**
 * Import templates are generated from the resource's live field definitions —
 * the same fields the importer validates against — so a template can never
 * drift from what the import accepts, including tenant custom fields.
 */

export interface TemplateField {
  key: string
  label: string
  kind: ResourceField['kind']
  required: boolean
  /** Reference fields name the target by its human key, never an id. */
  reference: { resource: string; by: string } | null
  options: string[]
}

/** Editable top-level fields; sublist fields and computed fields are not importable columns. */
export function templateFields(fields: readonly ResourceField[]): TemplateField[] {
  return fields
    .filter((field) => !field.readOnly && !field.section)
    .map((field) => ({
      key: field.key,
      label: field.label,
      kind: field.kind,
      required: field.required === true,
      reference: field.ref ? { resource: field.ref.resource, by: field.ref.by } : null,
      options: (field.options ?? []).map((option) => option.value).slice(0, 40),
    }))
}

export type TemplateNoteText = (field: TemplateField) => string

export function templateColumns(fields: readonly TemplateField[], note: TemplateNoteText): ImportTemplateColumn[] {
  return fields.map((field) => ({ key: field.key, required: field.required, note: note(field) }))
}

function csvCell(value: string): string {
  const guarded = String(guardCsvCell(value) ?? '')
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded
}

export function templateCsv(fields: readonly TemplateField[]): string {
  return `${fields.map((field) => csvCell(field.key)).join(',')}\r\n`
}

export function templateXlsx(label: string, fields: readonly TemplateField[], note: TemplateNoteText): Promise<Buffer> {
  return importTemplateXlsx(label, templateColumns(fields, note))
}

export function templateFilename(resourceKey: string, format: 'csv' | 'xlsx'): string {
  return `${resourceKey.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'import'}-template.${format}`
}
