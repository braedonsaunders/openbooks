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
      `</td>`
    : `<td style="vertical-align:top;"></td>`

  const sourceHtml =
    `<div style="${FONT}color:${INK};">` +
    // ---- Brand band ----
    `<table style="width:100%;border-collapse:collapse;margin:0 0 6px;"><tbody><tr>` +
    `<td style="vertical-align:bottom;">` +
    `<div style="font-size:19px;font-weight:800;letter-spacing:-.01em;color:${accent};">{{org_name}}</div>` +
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
        `<tr>${th('Description')}${th('Qty', 'right', '52px')}${th('Rate', 'right', '76px')}${th('Amount', 'right', '92px')}</tr>` +
        `<tr data-each="lines">${td('description')}${td('quantity', 'right')}${td('unit_price', 'right')}${td('amount', 'right')}</tr>` +
        `</tbody></table>`) +
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

export function starterTemplate(meta: PdfRecordTypeMeta, accent?: string | null): StarterTemplate {
  const color = accent && /^#[0-9a-fA-F]{3,8}$/.test(accent) ? accent : '#0f766e'
  if (meta.key === 'journal_entry') return journalStarter(meta, color)
  if (meta.key === 'field_ticket') return fieldTicketStarter(meta, color)
  return documentStarter(meta, color)
}
