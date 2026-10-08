/** Title-case a snake_case identifier: "vendor_bill" -> "Vendor Bill". Must
 *  match the SQL backfill (initcap(replace(kind,'_',' '))) so grouping folders
 *  created here and by the migration resolve to the same name. */
export function titleizeKind(s: string): string {
  return s
    .split('_')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
}

export function deriveFileType(contentType: string): string {
  if (contentType === 'application/pdf') return 'pdf'
  if (contentType.startsWith('image/')) return 'image'
  if (contentType === 'text/csv') return 'csv'
  if (contentType.includes('spreadsheet')) return 'spreadsheet'
  if (contentType.includes('wordprocessing')) return 'document'
  if (contentType.startsWith('text/')) return 'text'
  return 'other'
}

export function deriveExtension(filename: string): string | null {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}
