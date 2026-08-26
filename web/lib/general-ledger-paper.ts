import type { PdfBranding } from '@openbooks/pdf'
import type { ExportData } from './report-pdf'
import { isExactDecimalText, pdfMoney } from './report-pdf-detail'

const htmlEscape = (value: unknown): string => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')
  // Footer HTML is passed through the shared {{page}}/{{pages}} expander.
  // Entity-encode braces so tenant-authored labels cannot inject counters.
  .replace(/\{/g, '&#123;')
  .replace(/\}/g, '&#125;')

export const escapedPrintText = (value: unknown): string => htmlEscape(value)
  .replace(/→/g, ' - ')
  .replace(/[–—]/g, '-')

/**
 * HTML paper view for the General Ledger. Its typography, spacing, rules and
 * account hierarchy deliberately mirror ReportPaper + ReportTable instead of
 * the generic pdfkit export table.
 */
export function generalLedgerPaperHtml(
  data: ExportData,
  branding: PdfBranding & { baseCurrency: string },
  locale = 'en',
): string {
  const sections = data.groups.map((group) => {
    const body = group.rows.map((row, rowIndex) => {
      const isOpening = rowIndex === 0
      const isClosing = rowIndex === group.rows.length - 1
      const cells = row.map((cell, columnIndex) => {
        const isMoney = group.money?.[columnIndex] === true
        const isExactMoney = isMoney && typeof cell === 'string' && isExactDecimalText(cell)
        const content = cell === null || cell === undefined || cell === ''
          ? ''
          : isExactMoney
            ? pdfMoney(cell, locale, branding.baseCurrency)
            : escapedPrintText(cell)
        const classes = [
          isMoney ? 'money' : '',
          isExactMoney && cell.startsWith('-') && /[1-9]/.test(cell) ? 'negative' : '',
        ].filter(Boolean).join(' ')
        return `<td class="${classes}">${content}</td>`
      }).join('')
      const classes = [
        isOpening ? 'opening' : '',
        isClosing ? 'closing' : '',
      ].filter(Boolean).join(' ')
      return `<tr class="${classes}">${cells}</tr>`
    }).join('')
    return `<section class="account-section">
      <table>
        <colgroup>
          <col class="date"><col class="entry"><col class="detail">
          <col class="debit"><col class="credit"><col class="balance">
        </colgroup>
        <thead>
          <tr class="account-title"><th colspan="${group.columns.length}">${escapedPrintText(group.title)}</th></tr>
          <tr>${group.columns.map((column, index) => `<th class="${group.money?.[index] === true ? 'money' : ''}">${escapedPrintText(column)}</th>`).join('')}</tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </section>`
  }).join('')

  return `<style>
    :root{color-scheme:light}
    *{box-sizing:border-box}
    body{
      margin:0;
      color:#0f172a;
      background:#fff;
      font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
      font-size:12px;
      line-height:1.35;
      -webkit-font-smoothing:antialiased;
      font-variant-numeric:tabular-nums;
    }
    .report-paper{width:100%;background:#fff;color:#0f172a}
    .report-header{margin:0 0 24px;text-align:center}
    .company{font-size:16px;font-weight:600}
    h1{margin:1px 0 0;font-size:20px;line-height:1.25;font-weight:700;letter-spacing:-.025em}
    .period{margin-top:2px;color:#64748b;font-size:14px}
    .account-section{margin:0 0 30px;break-inside:auto}
    table{width:100%;border-collapse:collapse;table-layout:fixed}
    thead{display:table-header-group}
    tr{break-inside:avoid;page-break-inside:avoid}
    th,td{overflow-wrap:anywhere}
    .account-title th{
      padding:0 0 5px;
      border:0;
      color:#0f172a;
      font-size:14px;
      font-weight:600;
      letter-spacing:0;
      text-align:left;
      text-transform:none;
    }
    thead tr:last-child{border-bottom:1px solid #cbd5e1}
    th{
      padding:7px 14px 7px 0;
      color:#64748b;
      font-size:10px;
      font-weight:600;
      letter-spacing:.045em;
      text-align:left;
      text-transform:uppercase;
      vertical-align:bottom;
    }
    td{padding:4px 14px 4px 0;vertical-align:top}
    th:last-child,td:last-child{padding-right:0}
    th.money,td.money{text-align:right;white-space:nowrap}
    td.negative{color:#dc2626}
    tr.opening td{color:#64748b;font-weight:500}
    tr.closing{border-top:1px solid #cbd5e1;border-bottom:3px double #94a3b8}
    tr.closing td{padding-top:6px;padding-bottom:6px;font-weight:600;color:#0f172a}
    col.date{width:12%} col.entry{width:13%} col.detail{width:39%}
    col.debit{width:12%} col.credit{width:12%} col.balance{width:12%}
  </style>
  <article class="report-paper">
    <header class="report-header">
      <div class="company">${escapedPrintText(branding.orgName)}</div>
      <h1>${escapedPrintText(data.title)}</h1>
      <div class="period">${escapedPrintText(data.dateRangeLabel)}</div>
    </header>
    ${sections}
  </article>`
}
