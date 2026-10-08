import ExcelJS from 'exceljs'
import { guardCsvCell } from '@openbooks/reports'

export interface ImportTemplateColumn {
  /** The field key the importer maps by; written as the header cell. */
  key: string
  /** Human guidance attached to the header cell as a note. */
  note: string
  required: boolean
}

/**
 * A one-sheet import template: a frozen header row of field keys and nothing
 * else, so the file re-imports through the same reader as any other upload
 * (every worksheet is data to the importer, so guidance never occupies a
 * second sheet or an example row). Field guidance rides as header-cell notes,
 * which the reader ignores. Required columns carry a tinted header.
 */
export async function importTemplateXlsx(sheetName: string, columns: readonly ImportTemplateColumn[], generatedAt = new Date()): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'openbooks'
  wb.created = generatedAt
  wb.modified = generatedAt
  const name = sheetName.replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31) || 'Import'
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  columns.forEach((column, index) => {
    const cell = ws.getCell(1, index + 1)
    cell.value = guardCsvCell(column.key) as string
    cell.font = { bold: true, color: { argb: column.required ? 'ff115e59' : 'ff374151' } }
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: column.required ? 'ffccfbf1' : 'fff1f5f9' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'ffd1d5db' } } }
    if (column.note) cell.note = column.note
    ws.getColumn(index + 1).width = Math.min(48, Math.max(14, column.key.length + 4))
  })
  const buf = await wb.xlsx.writeBuffer()
  return Buffer.isBuffer(buf) ? buf : Buffer.from(buf as ArrayBuffer)
}
