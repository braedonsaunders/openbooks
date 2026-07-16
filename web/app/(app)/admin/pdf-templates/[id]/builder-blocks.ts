/** Block-HTML builders shared by the PDF builder palette (client-safe). */

export type PaletteField = { key: string; label?: string }
export type PaletteCollection = {
  key: string
  label: string
  fields: { key: string; label: string }[]
}

const TEMPLATE_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/

export function safeTemplateKey(value: string): string | null {
  const key = value.trim()
  return TEMPLATE_KEY.test(key) ? key : null
}

/**
 * GrapesJS stores authored CSS rules separately from its component HTML.
 * Persist the two together so reopening or compiling a design cannot silently
 * lose styles.
 */
export function serializeTemplateEditor(editor: {
  getHtml: () => string
  getCss?: () => string | undefined
}): string {
  const css = editor.getCss?.() ?? ''
  const html = editor.getHtml()
  return css ? `<style>${css}</style>${html}` : html
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function mergeFieldBlockHtml(field: PaletteField): string | null {
  const key = safeTemplateKey(field.key)
  return key ? `<span style="color:#0f172a;">{{${key}}}</span>` : null
}

const TABLE_HEADER_STYLE =
  'text-align:left;border-bottom:2px solid #e2e8f0;padding:6px 8px;font-size:11px;color:#475569;font-weight:700;text-transform:uppercase'
const TABLE_CELL_STYLE =
  'border-bottom:1px solid #eef2f7;padding:6px 8px;font-size:13px;color:#0f172a;vertical-align:top'

/** One editable repeating-row table (header row + data-each body row). */
export function collectionTableBlockHtml(collection: PaletteCollection): string | null {
  const collectionKey = safeTemplateKey(collection.key)
  if (!collectionKey || collection.fields.length === 0) return null

  const fields = collection.fields.map((field) => ({
    key: safeTemplateKey(field.key),
    label: escapeHtml(field.label),
  }))
  if (fields.some((field) => field.key === null)) return null

  const head = fields.map((field) => `<th style="${TABLE_HEADER_STYLE}">${field.label}</th>`).join('')
  const body = fields.map((field) => `<td style="${TABLE_CELL_STYLE}">{{${field.key!}}}</td>`).join('')
  return (
    '<table style="width:100%;border-collapse:collapse;margin:0 0 8px;">' +
    `<tr>${head}</tr><tr data-each="${collectionKey}">${body}</tr></table>`
  )
}
