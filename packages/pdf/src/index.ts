// @openbooks/pdf — the pure-JS PDF document renderer (pdfkit, no Chromium).
// Server-only: import from route handlers / server components only.

export * from './types'
export * from './page'
export { drawTable, computeColumnWidths } from './table'
export { renderPdfDocument } from './document'
export { renderStatementPdf } from './statement'
export type {
  StatementPdfInput,
  StatementPdfColumn,
  StatementPdfColumnKind,
  StatementPdfRow,
  StatementPdfStyle,
} from './statement'
