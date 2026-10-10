/**
 * Starter designs for org PDF templates — the beautiful default every record
 * type gets when a template is created (and the built-in fallback the render
 * route prints when an org hasn't authored one). Inline-styled HTML with
 * {{merge}} tokens and data-each/data-if repeat markers, compiled/sanitized by
 * @openbooks/pdf compileTemplateHtml on save.
 *
 * Design language: generous whitespace, a single accent (the org's brand
 * primary), slate ink ramp, hairline rules — matches the app's modern
 * statement PDF style.
 */

import type { PdfRecordTypeMeta } from './catalog'

const INK = '#0f172a'
const MUTED = '#64748b'
const FAINT = '#94a3b8'
const RULE = '#e2e8f0'
const WASH = '#f8fafc'
const FONT = "font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;"

export type StarterTemplate = {
  sourceHtml: string
  headerHtml: string
  footerHtml: string
  paperSize?: 'letter' | 'a4' | 'legal' | '4x6'
  orientation?: 'portrait' | 'landscape'
  marginMm?: number
}

const th = (label: string, align = 'left', width?: string) =>
  `<th style="text-align:${align};${width ? `width:${width};` : ''}padding:7px 10px;font-size:9.5px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};font-weight:700;border-bottom:2px solid ${INK};">${label}</th>`

const td = (token: string, align = 'left') =>
  `<td style="text-align:${align};padding:8px 10px;font-size:11.5px;color:${INK};border-bottom:1px solid ${RULE};vertical-align:top;">{{${token}}}</td>`

function metaCell(label: string, token: string): string {
  return (
    `<td style="padding:0 28px 0 0;vertical-align:top;">` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:3px;">${label}</div>` +
    `<div style="font-size:12px;color:${INK};font-weight:600;">{{${token}}}</div>` +
    `</td>`
  )
}

function totalsRow(label: string, token: string, opts?: { strong?: boolean; accent?: string }): string {
  const strong = opts?.strong
  const labelStyle = strong
    ? `font-size:12px;color:${INK};font-weight:700;`
    : `font-size:11px;color:${MUTED};`
  const valueStyle = strong
    ? `font-size:15px;color:${opts?.accent ?? INK};font-weight:700;`
    : `font-size:11.5px;color:${INK};`
  const border = strong ? `border-top:2px solid ${INK};` : ''
  return (
    `<tr><td style="padding:5px 18px 5px 0;text-align:right;${labelStyle}${border}">${label}</td>` +
    `<td style="padding:5px 0;text-align:right;white-space:nowrap;${valueStyle}${border}">{{${token}}}</td></tr>`
  )
}

/** The polished transaction-document starter (invoice, bill, quote, PO…). */
function documentStarter(meta: PdfRecordTypeMeta, accent: string): StarterTemplate {
  const hasParty = meta.partyHeading !== null
  const hasDue = meta.fields.some((f) => f.key === 'due_date')
  const hasReference = meta.fields.some((f) => f.key === 'reference_number')
  const hasFiscalIdentity = meta.fields.some((f) => f.key === 'seller_address')

  const metaCells = [
    metaCell('Date', 'document_date'),
    hasDue ? metaCell('Due date', 'due_date') : '',
    hasReference ? metaCell('Reference', 'reference_number') : '',
    metaCell('Status', 'status'),
  ].join('')

  const partyBlock = hasParty
    ? `<td style="vertical-align:top;">` +
      `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:5px;">${meta.partyHeading}</div>` +
      `<div style="font-size:13.5px;color:${INK};font-weight:700;padding-bottom:2px;">{{party_name}}</div>` +
      `<div style="font-size:11px;color:${MUTED};line-height:1.55;">{{party_address}}</div>` +
      `<div style="font-size:11px;color:${MUTED};line-height:1.55;">{{party_email}}</div>` +
      (hasFiscalIdentity ? `<div data-if="buyer_vat_id" style="font-size:11px;color:${MUTED};">VAT: {{buyer_vat_id}}</div>` +
        `<div data-if="buyer_legal_registration" style="font-size:11px;color:${MUTED};">Registration: {{buyer_legal_registration}}</div>` +
        `<div data-if="buyer_electronic_address" style="font-size:11px;color:${MUTED};">{{buyer_electronic_address}}</div>` : '') +
      `</td>`
    : `<td style="vertical-align:top;"></td>`

  const sourceHtml =
    `<div style="${FONT}color:${INK};">` +
    // ---- Brand band ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 6px;"><tbody><tr>` +
    `<td style="vertical-align:bottom;">` +
    `<div style="font-size:19px;font-weight:800;letter-spacing:-.01em;color:${accent};">{{org_name}}</div>` +
    // Seller identity. Fiscal invoice types print the e-invoice seller block
    // their embedded invoice requires; every other document prints the
    // registered address and tax numbers from Company & Accounting → Legal
    // identity. Lines collapse when not recorded.
    (hasFiscalIdentity ? `<div data-if="seller_address" style="font-size:10px;color:${MUTED};line-height:1.6;max-width:320px;">{{seller_address}}</div>` +
      `<div data-if="seller_vat_id" style="font-size:10px;color:${MUTED};">VAT: {{seller_vat_id}}</div>` +
      `<div data-if="seller_tax_number" style="font-size:10px;color:${MUTED};">Tax registration: {{seller_tax_number}}</div>` +
      `<div data-if="seller_legal_registration" style="font-size:10px;color:${MUTED};">Registration: {{seller_legal_registration}}</div>` +
      `<div data-if="seller_contact" style="font-size:10px;color:${MUTED};">{{seller_contact}}</div>` +
      `<div data-if="seller_electronic_address" style="font-size:10px;color:${MUTED};">{{seller_electronic_address}}</div>`
      : `<div data-if="org_address" style="font-size:10px;color:${MUTED};line-height:1.6;max-width:320px;">{{org_address}}</div>` +
        `<div data-if="org_tax_ids" style="font-size:10px;color:${MUTED};">{{org_tax_ids}}</div>`) +
    `</td>` +
    `<td style="vertical-align:bottom;text-align:right;">` +
    `<div style="font-size:26px;font-weight:800;letter-spacing:.02em;color:${INK};text-transform:uppercase;">${meta.docTitle}</div>` +
    `<div style="font-size:12px;color:${MUTED};padding-top:2px;">{{document_number}}</div>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<div style="height:3px;background:${accent};margin:0 0 22px;"></div>` +
    // ---- Party + meta ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 24px;"><tbody><tr>` +
    partyBlock +
    `<td style="vertical-align:top;text-align:right;">` +
    `<table style="border-collapse:collapse;margin-left:auto;"><tbody><tr>${metaCells}</tr></tbody></table>` +
    `</td>` +
    `</tr></tbody></table>` +
    // ---- Lines ----
    (meta.key === 'journal'
      ? `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody>` +
        `<tr>${th('Account')}${th('Description')}${th('Amount', 'right', '92px')}</tr>` +
        `<tr data-each="lines">${td('account_name')}${td('description')}${td('amount', 'right')}</tr>` +
        `</tbody></table>`
      : `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody>` +
        `<tr>${th('Item / customer part #')}${th('Description')}${th('Qty', 'right', '52px')}${th('Rate', 'right', '76px')}${th('Amount', 'right', '92px')}</tr>` +
        `<tr data-each="lines"><td style="padding:8px 10px;font-size:11.5px;color:${INK};border-bottom:1px solid ${RULE};vertical-align:top;">{{item_name}}<div data-if="customer_sku" style="font-size:9.5px;color:${MUTED};padding-top:3px;">Customer part #: {{customer_sku}}</div></td>${td('description')}${hasFiscalIdentity ? td('quantity', 'right').replace('{{quantity}}', '{{quantity}} {{unit}}') : td('quantity', 'right')}${td('unit_price', 'right')}${td('amount', 'right')}</tr>` +
        `</tbody></table>`) +
    (hasFiscalIdentity ? `<div data-if="seller_address" style="font-size:10px;color:${MUTED};margin:0 0 8px;">Currency: {{currency}}</div>` +
      `<table data-if="vat_breakdown" style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody>` +
      `<tr>${th('VAT category')}${th('Rate', 'right')}${th('Taxable amount', 'right')}${th('VAT amount', 'right')}${th('Exemption')}</tr>` +
      `<tr data-each="vat_breakdown">${td('category')}${td('rate', 'right')}${td('taxable_amount', 'right')}${td('tax_amount', 'right')}<td style="padding:8px 10px;font-size:10px;border-bottom:1px solid ${RULE};">{{exemption_reason}} {{exemption_reason_code}}</td></tr>` +
      `</tbody></table>` : '') +
    // ---- Totals ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 26px;"><tbody><tr>` +
    `<td style="vertical-align:top;">` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:4px;">Notes</div>` +
    `<div style="font-size:11px;color:${MUTED};line-height:1.6;max-width:320px;">{{memo}}</div>` +
    `</td>` +
    `<td style="vertical-align:top;text-align:right;width:280px;">` +
    `<table style="border-collapse:collapse;margin-left:auto;"><tbody>` +
    totalsRow('Subtotal', 'subtotal') +
    totalsRow('Tax', 'tax_total') +
    totalsRow('Total', 'total', { strong: true, accent }) +
    (hasDue ? totalsRow('Balance due', 'balance_due') : '') +
    `</tbody></table>` +
    `</td>` +
    `</tr></tbody></table>` +
    (hasFiscalIdentity ? `<div data-if="payment_means" style="font-size:10px;color:${MUTED};line-height:1.6;margin-bottom:14px;">` +
      `<div>Payment: {{payment_means}}</div><div data-if="payee_account">Account / IBAN: {{payee_account}}</div>` +
      `<div data-if="payee_name">{{payee_name}}</div><div data-if="payee_bic">{{payee_bic}}</div>` +
      `<div data-if="payment_reference">Payment reference: {{payment_reference}}</div></div>` : '') +
    // ---- Footer note ----
    `<div style="border-top:1px solid ${RULE};padding-top:10px;font-size:9.5px;color:${FAINT};">` +
    `Thank you for your business. Questions about this document? Contact {{org_name}}.` +
    `</div>` +
    `</div>`

  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: `{{org_name}} · ${meta.docTitle} {{document_number}} · Page {{page}} of {{pages}}`,
  }
}

/** Debit/credit starter for journal entries. */
/**
 * The payroll-bureau stub employees already know: company block, an address
 * block that sits in a #10 window envelope, a tear rule, then the statement
 * of earnings in two columns — earnings and hours beside the employee's
 * banks, income-tax withholdings beside taxable company items, then every
 * other deduction as an adjustment to net pay. Every row carries its
 * year-to-date figure. Plain black-and-grey on purpose: it is a pay record,
 * not a branded sales document. Employers restyle it in the designer.
 */
function payStubStarter(): StarterTemplate {
  const STUB_INK = '#111111'
  const cell = 'padding:1px 0;font-size:9.5px;line-height:1.35;vertical-align:top;'
  const num = `${cell}text-align:right;white-space:nowrap;`
  const head = (label: string, align = 'left', width?: string) =>
    `<th style="text-align:${align};${width ? `width:${width};` : ''}padding:0 0 2px;font-size:9px;font-weight:700;color:${STUB_INK};border-bottom:1px solid ${STUB_INK};">${label}</th>`
  const subtotal = (current: string, ytd: string, leadCols: number) =>
    `<tr><td colspan="${leadCols}"></td>` +
    `<td style="${num}border-top:1px solid ${STUB_INK};padding-top:3px;font-size:9px;">{{${current}}}</td>` +
    `<td style="${num}border-top:1px solid ${STUB_INK};padding-top:3px;font-size:9px;">{{${ytd}}}</td></tr>`
  const section = (title: string, collection: string, totals: [string, string] | null) =>
    `<table style="width:100%;border-collapse:collapse;margin:0 0 12px;"><tbody>` +
    `<tr>${head(title)}${head('Current', 'right', '70px')}${head('YTD Amount', 'right', '78px')}</tr>` +
    `<tr data-each="${collection}"><td style="${cell}">{{description}}</td><td style="${num}">{{current}}</td><td style="${num}">{{ytd_amount}}</td></tr>` +
    (totals ? subtotal(totals[0], totals[1], 1) : '') +
    `</tbody></table>`

  const sourceHtml =
    `<div style="${FONT}color:${STUB_INK};">` +
    // ---- company block ----------------------------------------------------
    `<div style="font-size:11px;font-weight:700;font-style:italic;color:${STUB_INK};">{{org_name}}</div>` +
    // ---- window-envelope address block ------------------------------------
    `<div style="margin:96px 0 0 52px;min-height:86px;font-size:11.5px;line-height:1.5;">` +
    `<div>{{employee_name}}</div>` +
    `<div>{{employee_address_line1}}</div>` +
    `<div data-if="employee_address_line2">{{employee_address_line2}}</div>` +
    `<div>{{employee_address_locality}}</div>` +
    `</div>` +
    // ---- tear rule + header ------------------------------------------------
    `<div style="border-top:1px dashed ${STUB_INK};margin:30px 0 8px;"></div>` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody><tr>` +
    `<td style="font-size:10px;">Employee Paystub</td>` +
    `<td style="font-size:10px;">Cheque number: {{cheque_number}}</td>` +
    `<td style="font-size:10px;">Pay Period: {{period_start}} to {{period_end}}</td>` +
    `<td style="font-size:10px;text-align:right;">Cheque Date: {{pay_date}}</td>` +
    `</tr></tbody></table>` +
    `<div style="font-size:10px;border-bottom:1px solid ${STUB_INK};width:66%;padding-bottom:1px;">Employee</div>` +
    `<div style="font-size:10px;padding:3px 0 14px;">{{employee_name}}, {{employee_address}}</div>` +
    // ---- statement of earnings, two columns -------------------------------
    `<table style="width:100%;border-collapse:collapse;"><tbody><tr>` +
    `<td style="width:51%;vertical-align:top;padding-right:12px;">` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 12px;"><tbody>` +
    `<tr>${head('Earnings and Hours')}${head('Qty', 'right', '44px')}${head('Rate', 'right', '52px')}${head('Current', 'right', '62px')}${head('YTD Amount', 'right', '70px')}</tr>` +
    `<tr data-each="earnings_detail"><td style="${cell}">{{description}}</td><td style="${num}">{{hours}}</td><td style="${num}">{{rate}}</td><td style="${num}">{{current}}</td><td style="${num}">{{ytd_amount}}</td></tr>` +
    subtotal('earnings_current_total', 'earnings_ytd_total', 3) +
    `</tbody></table>` +
    section('Withholdings', 'withholdings', ['withholdings_current_total', 'withholdings_ytd_total']) +
    section('Adjustments to Net Pay', 'net_adjustments', ['net_adjustments_current_total', 'net_adjustments_ytd_total']) +
    `<table style="width:100%;border-collapse:collapse;"><tbody><tr>` +
    `<td style="${cell}font-weight:700;">Net pay</td>` +
    `<td style="${num}font-weight:700;width:70px;">{{net_pay}}</td>` +
    `<td style="${num}font-weight:700;width:78px;">{{ytd_net}}</td>` +
    `</tr></tbody></table>` +
    `</td>` +
    `<td style="width:49%;vertical-align:top;padding-left:12px;">` +
    section('Taxable Company Items', 'taxable_company_items', null) +
    `</td>` +
    `</tr></tbody></table>` +
    `</div>`

  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: '',
  }
}

/**
 * The classic cheque-on-top, voucher-below sheet: cheque body in the upper
 * third (payee, courtesy amount, legal amount, signature rule), the pay detail
 * beneath it as the employee's stub. Every employer re-lays this out for their
 * own stock — that is what the template designer is for — but the default has
 * to be a printable cheque, not a placeholder.
 */
function chequeStarter(meta: PdfRecordTypeMeta, accent: string): StarterTemplate {
  const sourceHtml =
    `<div style="${FONT}color:${INK};">` +
    // ---- cheque body -----------------------------------------------------
    `<table style="width:100%;border-collapse:collapse;margin:0 0 4px;"><tbody><tr>` +
    `<td style="vertical-align:top;"><div style="font-size:17px;font-weight:800;color:${accent};">{{org_name}}</div></td>` +
    `<td style="vertical-align:top;text-align:right;">` +
    `<div style="font-size:15px;font-weight:800;color:${INK};">{{cheque_number}}</div>` +
    `<div style="font-size:11px;color:${MUTED};padding-top:2px;">{{pay_date}}</div>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<table style="width:100%;border-collapse:collapse;margin:14px 0 6px;"><tbody><tr>` +
    `<td style="vertical-align:bottom;">` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:3px;">${meta.partyHeading ?? 'Pay to the order of'}</div>` +
    `<div style="font-size:14px;font-weight:700;color:${INK};border-bottom:1px solid ${INK};padding-bottom:4px;">{{employee_name}}</div>` +
    `</td>` +
    `<td style="vertical-align:bottom;text-align:right;width:180px;padding-left:24px;">` +
    `<div style="font-size:18px;font-weight:800;color:${INK};border:1px solid ${INK};padding:6px 10px;">{{amount}}</div>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<div style="font-size:12px;color:${INK};border-bottom:1px solid ${INK};padding:6px 0 4px;">{{amount_in_words}} <span style="color:${FAINT};">{{currency}}</span></div>` +
    `<table style="width:100%;border-collapse:collapse;margin:14px 0 0;"><tbody><tr>` +
    `<td style="vertical-align:bottom;font-size:10px;color:${MUTED};">{{employee_address}}<div style="padding-top:6px;">Memo: {{memo}}</div></td>` +
    `<td style="vertical-align:bottom;width:240px;padding-left:24px;">` +
    `<div style="border-top:1px solid ${INK};margin-top:26px;padding-top:4px;font-size:9.5px;color:${MUTED};text-align:center;">Authorized signature</div>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<div style="height:3px;background:${accent};margin:26px 0 4px;"></div>` +
    // ---- voucher ---------------------------------------------------------
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding:0 0 12px;">` +
    `Statement of earnings · {{document_number}} · {{period_start}} – {{period_end}}</div>` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody>` +
    `<tr>${th('Earnings')}${th('Hours', 'right', '70px')}${th('Rate', 'right', '80px')}${th('Amount', 'right', '92px')}</tr>` +
    `<tr data-each="earnings">${td('description').replace('</td>', '<span data-if="non_cash" style="font-size:9px;color:#64748b;"> · Non-cash</span></td>')}${td('hours', 'right')}${td('rate', 'right')}${td('amount', 'right')}</tr>` +
    `</tbody></table>` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody>` +
    `<tr>${th('Deductions')}${th('Amount', 'right', '92px')}</tr>` +
    `<tr data-each="deductions">${td('description')}${td('amount', 'right')}</tr>` +
    `</tbody></table>` +
    `<table style="border-collapse:collapse;margin-left:auto;"><tbody>` +
    totalsRow('Gross pay', 'gross') +
    totalsRow('Non-cash benefits', 'non_cash_earnings').replace('<tr', '<tr data-if="has_non_cash_earnings"') +
    totalsRow('Cash earnings', 'cash_gross').replace('<tr', '<tr data-if="has_non_cash_earnings"') +
    totalsRow('Total deductions', 'total_deductions') +
    totalsRow('Net pay', 'net_pay', { strong: true, accent }) +
    `</tbody></table>` +
    `<div style="border-top:1px solid ${RULE};margin-top:18px;padding-top:10px;font-size:9.5px;color:${FAINT};">Printed {{printed_date}} · {{org_name}} · Confidential</div>` +
    `</div>`

  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: `{{org_name}} · ${meta.docTitle} {{cheque_number}} · Page {{page}} of {{pages}}`,
  }
}

function journalStarter(meta: PdfRecordTypeMeta, accent: string): StarterTemplate {
  const sourceHtml =
    `<div style="${FONT}color:${INK};">` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 6px;"><tbody><tr>` +
    `<td style="vertical-align:bottom;"><div style="font-size:19px;font-weight:800;color:${accent};">{{org_name}}</div></td>` +
    `<td style="vertical-align:bottom;text-align:right;">` +
    `<div style="font-size:26px;font-weight:800;letter-spacing:.02em;text-transform:uppercase;color:${INK};">${meta.docTitle}</div>` +
    `<div style="font-size:12px;color:${MUTED};padding-top:2px;">{{entry_number}}</div>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<div style="height:3px;background:${accent};margin:0 0 22px;"></div>` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 24px;"><tbody><tr>` +
    metaCell('Posting date', 'posting_date') +
    metaCell('Status', 'status') +
    metaCell('Origin', 'origin') +
    `</tr></tbody></table>` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 14px;"><tbody>` +
    `<tr>${th('#', 'left', '36px')}${th('Account')}${th('Memo')}${th('Debit', 'right', '92px')}${th('Credit', 'right', '92px')}</tr>` +
    `<tr data-each="lines">${td('line_number')}${td('account_name')}${td('memo')}${td('debit', 'right')}${td('credit', 'right')}</tr>` +
    `</tbody></table>` +
    `<table style="width:100%;border-collapse:collapse;margin:0 0 26px;"><tbody><tr>` +
    `<td style="vertical-align:top;">` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:4px;">Memo</div>` +
    `<div style="font-size:11px;color:${MUTED};line-height:1.6;max-width:320px;">{{memo}}</div>` +
    `</td>` +
    `<td style="vertical-align:top;text-align:right;width:280px;">` +
    `<table style="border-collapse:collapse;margin-left:auto;"><tbody>` +
    totalsRow('Total debits', 'total_debits') +
    totalsRow('Total credits', 'total_credits', { strong: true, accent }) +
    `</tbody></table>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<div style="border-top:1px solid ${RULE};padding-top:10px;font-size:9.5px;color:${FAINT};">Printed {{printed_date}} · {{org_name}}</div>` +
    `</div>`

  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: `{{org_name}} · ${meta.docTitle} {{entry_number}} · Page {{page}} of {{pages}}`,
  }
}

/** The starter design for a record type, tinted with the org's brand accent. */

/**
 * Field-ticket starter — the modern signed crew timesheet. Summarized crew
 * table (Reg/OT/DT), equipment & materials, totals, and a signature block.
 * The full per-day grid keys (day1_reg … day7_dt + day1_label…) are available
 * to authors who want an exact classic weekly-grid replica.
 */
function fieldTicketStarter(meta: PdfRecordTypeMeta, accent: string): StarterTemplate {
  const sourceHtml =
    `<div style="${FONT}color:${INK};">` +
    // masthead
    `<table style="width:100%;border-collapse:collapse;margin-bottom:22px;"><tr>` +
    `<td style="vertical-align:top;">` +
    `<div style="font-size:20px;font-weight:800;letter-spacing:-.01em;">{{org_name}}</div>` +
    `<div style="font-size:10.5px;color:${MUTED};padding-top:2px;">${meta.docTitle}</div>` +
    `</td>` +
    `<td style="vertical-align:top;text-align:right;">` +
    `<div style="font-size:16px;font-weight:800;color:${accent};">{{document_number}}</div>` +
    `<div style="font-size:10.5px;color:${MUTED};padding-top:2px;">{{period}} · {{period_start}} → {{period_end}}</div>` +
    `</td></tr></table>` +
    // meta band
    `<table style="width:100%;border-collapse:collapse;margin-bottom:18px;background:${WASH};border-radius:8px;"><tr>` +
    `<td style="padding:12px 16px;">` +
    `<table style="border-collapse:collapse;"><tr>` +
    metaCell('Customer', 'party_name') +
    metaCell('Project', 'project_name') +
    metaCell('Customer PO', 'po_number') +
    metaCell('Foreman', 'foreman_name') +
    metaCell('Status', 'status') +
    `</tr></table>` +
    `</td></tr></table>` +
    `<div data-if="work_description" style="font-size:11.5px;color:${INK};line-height:1.6;margin-bottom:18px;"><span style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};display:block;padding-bottom:3px;">Work description</span>{{work_description}}</div>` +
    // crew hours
    `<div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};font-weight:700;padding-bottom:6px;">Crew hours</div>` +
    `<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">` +
    `<thead><tr>` +
    th('Employee') + th('Class') + th('Reg', 'right') + th('OT', 'right') + th('DT', 'right') + th('Hours', 'right') + th('Amount', 'right') +
    `</tr></thead>` +
    `<tbody><tr data-each="crew">` +
    td('employee_name') + td('labor_class') + td('reg_hours', 'right') + td('ot_hours', 'right') + td('dt_hours', 'right') + td('total_hours', 'right') + td('amount', 'right') +
    `</tr></tbody></table>` +
    // equipment & materials
    `<div data-if="lines" style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${MUTED};font-weight:700;padding-bottom:6px;">Equipment, consumables &amp; materials</div>` +
    `<table data-if="lines" style="width:100%;border-collapse:collapse;margin-bottom:20px;">` +
    `<thead><tr>` +
    th('Item') + th('Description') + th('Qty', 'right') + th('Rate', 'right') + th('Amount', 'right') +
    `</tr></thead>` +
    `<tbody><tr data-each="lines">` +
    td('item_name') + td('description') + td('quantity', 'right') + td('unit_price', 'right') + td('amount', 'right') +
    `</tr></tbody></table>` +
    // totals
    `<table style="width:100%;border-collapse:collapse;margin-bottom:26px;"><tr><td></td>` +
    `<td style="width:260px;"><table style="width:100%;border-collapse:collapse;">` +
    totalsRow('Labor', 'labor_total') +
    totalsRow('Equipment &amp; materials', 'lines_total') +
    totalsRow('Total', 'grand_total', { strong: true, accent }) +
    `</table></td></tr></table>` +
    // signatures
    `<table style="width:100%;border-collapse:collapse;"><tr>` +
    `<td style="width:50%;padding-right:20px;vertical-align:bottom;">` +
    `<div data-if="foreman_signature_image"><img src="{{foreman_signature_image}}" style="max-height:52px;" /></div>` +
    `<div style="border-top:1px solid ${INK};margin-top:6px;padding-top:4px;font-size:9.5px;color:${MUTED};">Foreman — {{foreman_name}}</div>` +
    `</td>` +
    `<td style="width:50%;padding-left:20px;vertical-align:bottom;">` +
    `<div data-if="customer_signature_image"><img src="{{customer_signature_image}}" style="max-height:52px;" /></div>` +
    `<div style="border-top:1px solid ${INK};margin-top:6px;padding-top:4px;font-size:9.5px;color:${MUTED};">Customer — {{customer_signature_name}} <span style="color:${FAINT};">{{customer_signed_at}}</span></div>` +
    `<div data-if="customer_comment" style="padding-top:4px;font-size:10px;color:${MUTED};font-style:italic;">&ldquo;{{customer_comment}}&rdquo;</div>` +
    `</td></tr></table>` +
    `</div>`

  return {
    sourceHtml,
    headerHtml: '',
    footerHtml:
      `<div style="${FONT}font-size:9px;color:${FAINT};width:100%;text-align:center;">` +
      `{{org_name}} · ${meta.docTitle} {{document_number}} · Printed {{printed_date}}</div>`,
  }
}

/**
 * Packing-slip starter for shipments: ship-to and carrier up top, then the
 * packed lines by carton. A packing slip travels in the box, so it carries
 * quantities and cartons and never prices.
 */
function packingSlipStarter(meta: PdfRecordTypeMeta, accent: string): StarterTemplate {
  const sourceHtml =
    `<div style="${FONT}color:${INK};">` +
    // ---- Brand band ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 6px;"><tbody><tr>` +
    `<td style="vertical-align:bottom;">` +
    `<div style="font-size:19px;font-weight:800;letter-spacing:-.01em;color:${accent};">{{org_name}}</div>` +
    `<div style="font-size:10.5px;color:${MUTED};padding-top:2px;">{{warehouse_name}}</div>` +
    `</td>` +
    `<td style="vertical-align:bottom;text-align:right;">` +
    `<div style="font-size:26px;font-weight:800;letter-spacing:.02em;color:${INK};text-transform:uppercase;">${meta.docTitle}</div>` +
    `<div style="font-size:12px;color:${MUTED};padding-top:2px;">{{document_number}}</div>` +
    `</td>` +
    `</tr></tbody></table>` +
    `<div style="height:3px;background:${accent};margin:0 0 22px;"></div>` +
    // ---- Ship-to + meta ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 18px;"><tbody><tr>` +
    `<td style="vertical-align:top;">` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};padding-bottom:5px;">${meta.partyHeading ?? ''}</div>` +
    `<div style="font-size:13.5px;color:${INK};font-weight:700;padding-bottom:2px;">{{ship_to_name}}</div>` +
    `<div style="font-size:11px;color:${MUTED};line-height:1.55;">{{ship_to_address}}</div>` +
    `<div style="font-size:11px;color:${MUTED};line-height:1.55;">{{party_phone}}</div>` +
    `</td>` +
    `<td style="vertical-align:top;text-align:right;">` +
    `<table style="border-collapse:collapse;margin-left:auto;"><tbody><tr>` +
    metaCell('Ship date', 'document_date') +
    metaCell('Sales order', 'sales_order_number') +
    metaCell('Customer', 'party_name') +
    `</tr></tbody></table>` +
    `</td>` +
    `</tr></tbody></table>` +
    // ---- Carrier band ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 22px;background:${WASH};border-radius:8px;"><tbody><tr>` +
    `<td style="padding:12px 16px;">` +
    `<table style="border-collapse:collapse;"><tbody><tr>` +
    metaCell('Carrier', 'carrier_name') +
    metaCell('Service', 'carrier_service') +
    metaCell('Tracking number', 'tracking_number') +
    metaCell('Cartons', 'carton_count') +
    `</tr></tbody></table>` +
    `</td></tr></tbody></table>` +
    // ---- Packed lines ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 20px;"><tbody>` +
    `<tr>${th('Item / customer part #')}${th('Description')}${th('Carton', 'left', '80px')}${th('Qty', 'right', '64px')}${th('Unit', 'left', '52px')}</tr>` +
    `<tr data-each="lines"><td style="padding:8px 10px;font-size:11.5px;color:${INK};border-bottom:1px solid ${RULE};vertical-align:top;">{{item_name}}<div data-if="customer_sku" style="font-size:9.5px;color:${MUTED};padding-top:3px;">Customer part #: {{customer_sku}}</div></td>${td('description')}${td('carton')}${td('quantity', 'right')}${td('unit')}</tr>` +
    `</tbody></table>` +
    `<div data-if="memo" style="font-size:11px;color:${MUTED};line-height:1.6;margin:0 0 20px;">` +
    `<span style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};display:block;padding-bottom:3px;">Notes</span>{{memo}}</div>` +
    // ---- Receipt ----
    `<table style="width:100%;border-collapse:collapse;"><tbody><tr>` +
    `<td style="width:50%;padding-right:20px;vertical-align:bottom;">` +
    `<div style="border-top:1px solid ${INK};margin-top:36px;padding-top:4px;font-size:9.5px;color:${MUTED};">Received by</div>` +
    `</td>` +
    `<td style="width:50%;padding-left:20px;vertical-align:bottom;">` +
    `<div style="border-top:1px solid ${INK};margin-top:36px;padding-top:4px;font-size:9.5px;color:${MUTED};">Date</div>` +
    `</td></tr></tbody></table>` +
    `</div>`

  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: `{{org_name}} · ${meta.docTitle} {{document_number}} · Page {{page}} of {{pages}}`,
  }
}

function cartonLabelStarter(accent: string): StarterTemplate {
  const sourceHtml =
    `<div data-each="cartons" style="${FONT}color:${INK};height:138mm;page-break-inside:avoid;overflow:hidden;">` +
    `<div style="font-size:15px;font-weight:800;color:${accent};">{{org_name}}</div>` +
    `<div style="font-size:10px;color:${MUTED};margin-top:4px;">{{warehouse_name}}</div>` +
    `<div style="border-top:2px solid ${INK};margin:8px 0 10px;"></div>` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};">Shipment</div>` +
    `<div style="font-size:22px;font-weight:800;">{{document_number}}</div>` +
    `<div style="font-size:14px;font-weight:700;margin-top:6px;">Carton {{carton_number}} of {{carton_total}} · {{carton}}</div>` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};margin-top:13px;">Ship to</div>` +
    `<div style="font-size:17px;font-weight:700;margin-top:3px;">{{ship_to_name}}</div>` +
    `<div style="font-size:13px;line-height:1.35;margin-top:3px;">{{ship_to_address}}</div>` +
    `<div style="display:flex;justify-content:center;margin-top:9mm;">{{barcode barcode}}</div>` +
    `</div>`
  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: '',
    paperSize: '4x6',
    orientation: 'portrait',
    marginMm: 5,
  }
}

function shippingLabelStarter(accent: string): StarterTemplate {
  const sourceHtml =
    `<div style="${FONT}color:${INK};height:138mm;overflow:hidden;">` +
    `<div style="font-size:15px;font-weight:800;color:${accent};">{{org_name}}</div>` +
    `<div style="border-top:2px solid ${INK};margin:8px 0 9px;"></div>` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};">Ship from</div>` +
    `<div style="font-size:13px;font-weight:700;margin-top:3px;">{{warehouse_name}}</div>` +
    `<div style="font-size:11px;line-height:1.35;margin-top:2px;">{{warehouse_address}}</div>` +
    `<div style="border-top:1px solid ${RULE};margin:9px 0;"></div>` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};">Ship to</div>` +
    `<div style="font-size:18px;font-weight:800;margin-top:4px;">{{ship_to_name}}</div>` +
    `<div style="font-size:14px;line-height:1.35;margin-top:3px;">{{ship_to_address}}</div>` +
    `<div style="border-top:1px solid ${RULE};margin:9px 0;"></div>` +
    `<div style="font-size:12px;font-weight:700;">{{carrier_name}} · {{carrier_service}}</div>` +
    `<div style="font-size:9px;letter-spacing:.1em;text-transform:uppercase;color:${FAINT};margin-top:7px;">Tracking number</div>` +
    `<div style="font-size:12px;font-weight:700;margin-top:2px;">{{tracking_number}}</div>` +
    `<div style="display:flex;justify-content:center;margin-top:5mm;">{{barcode tracking_number}}</div>` +
    `</div>`
  return {
    sourceHtml,
    headerHtml: '',
    footerHtml: '',
    paperSize: '4x6',
    orientation: 'portrait',
    marginMm: 5,
  }
}

export function starterTemplate(meta: PdfRecordTypeMeta, accent?: string | null): StarterTemplate {
  const color = accent && /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#0f766e'
  if (meta.key === 'journal_entry') return journalStarter(meta, color)
  if (meta.key === 'pay_stub') return payStubStarter()
  if (meta.key === 'payroll_cheque') return chequeStarter(meta, color)
  if (meta.key === 'field_ticket') return fieldTicketStarter(meta, color)
  if (meta.key === 'shipment_carton_label') return cartonLabelStarter(color)
  if (meta.key === 'shipment_shipping_label') return shippingLabelStarter(color)
  if (meta.key === 'shipment') return packingSlipStarter(meta, color)
  return documentStarter(meta, color)
}
