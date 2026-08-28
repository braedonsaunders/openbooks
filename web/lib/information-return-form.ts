import {
  filedBoxAmounts,
  formDefinition,
  type FormDefinition,
} from '@openbooks/engine/src/information-returns.ts'

/**
 * Recipient copies of information returns (1099-NEC / 1099-MISC / T4A) as
 * self-authored, form-faithful facsimiles.
 *
 * Same doctrine as the indirect-tax facsimiles: we render our OWN boxed grid
 * that reproduces the layout and box numbering of the official form, and print
 * a "not for filing with the tax authority" notice — the recipient copy is the
 * one a payer is permitted to furnish on a substitute form, whereas the agency
 * copy must be transmitted electronically or on scannable stock. Making that
 * distinction visible on the page is the point: nobody should mail this to the
 * IRS believing it will be accepted.
 *
 * Pure module — the Chromium print step is in information-return-pdf.ts.
 */

export interface RecipientFormData {
  formType: string
  taxYear: number
  /** Payer identification, from the filing's frozen snapshot. */
  payerName: string
  payerAddress?: string | null
  payerTin?: string | null
  recipientName: string
  recipientAddress?: string | null
  /** Masked, e.g. "***-**-1234". The full TIN never leaves the sealed column. */
  recipientTinMasked?: string | null
  accountNumber?: string | null
  computedAmounts: Record<string, string>
  adjustments: Record<string, string>
  corrected: boolean
  void: boolean
  currency: string
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

const DECIMAL_TEXT = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/

/** Whether a decimal string is mathematically zero, without a float round-trip. */
function isZeroDecimalText(value: string | undefined): boolean {
  if (value === undefined) return true
  const raw = value.trim()
  if (raw === '') return true
  if (!DECIMAL_TEXT.test(raw)) return false
  const mantissa = raw.split(/[eE]/, 1)[0]!.replace(/^[-+]/, '')
  return !/[1-9]/.test(mantissa)
}

/** Money as the form prints it: two decimals, thousands separated, blank at zero. */
export function formatBoxAmount(amount: string | undefined): string {
  if (amount === undefined) return ''
  const raw = amount.trim()
  if (!DECIMAL_TEXT.test(raw) || isZeroDecimalText(raw)) return ''
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(raw as never)
  // Keep the old non-finite-input behavior for values such as "1e309".
  return formatted.includes('∞') ? '' : formatted
}

/** Mask a TIN for the recipient copy, keeping only the last four digits. */
export function maskTin(last4: string | null | undefined, tinType: string | null | undefined): string {
  if (!last4) return ''
  if (tinType === 'ein' || tinType === 'bn') return `**-***${last4}`
  if (tinType === 'sin') return `***-***-${last4}`
  return `***-**-${last4}`
}

interface BoxCell {
  number: string
  name: string
  value: string
  isIndicator: boolean
}

function boxCells(form: FormDefinition, amounts: Record<string, string>): BoxCell[] {
  return form.boxes.map((box) => ({
    number: box.number,
    name: box.name,
    value: box.isIndicator
      ? !isZeroDecimalText(amounts[box.key] ?? '0')
        ? 'X'
        : ''
      : formatBoxAmount(amounts[box.key]),
    isIndicator: box.isIndicator === true,
  }))
}

/** The printable recipient copy. */
export function renderInformationReturnBody(data: RecipientFormData): string {
  const form = formDefinition(data.formType)
  const amounts = filedBoxAmounts(data.computedAmounts, data.adjustments)
  const cells = boxCells(form, amounts)
  return `
<style>
  :root { --ink: #0f172a; --muted: #64748b; --rule: #94a3b8; }
  * { box-sizing: border-box; }
  body { font-family: Helvetica, Arial, sans-serif; color: var(--ink); font-size: 9pt; margin: 0; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid var(--ink); padding-bottom: 6px; }
  .head .form { text-align: right; }
  .head .form .code { font-size: 20pt; font-weight: bold; letter-spacing: -0.02em; }
  .head .form .year { font-size: 15pt; font-weight: bold; }
  .head .form .name { font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .head .agency { font-size: 8pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .flags { margin-top: 6px; font-size: 8.5pt; }
  .flags span { border: 1px solid var(--ink); padding: 1px 6px; margin-right: 6px; font-weight: bold; }
  .parties { display: flex; gap: 0; margin-top: 10px; border: 1px solid var(--rule); }
  .parties > div { flex: 1; padding: 7px 9px; }
  .parties > div + div { border-left: 1px solid var(--rule); }
  .caption { font-size: 7pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }
  .value { white-space: pre-line; line-height: 1.35; }
  .boxes { display: flex; flex-wrap: wrap; margin-top: 10px; border: 1px solid var(--rule); border-bottom: none; }
  .box { width: 50%; border-bottom: 1px solid var(--rule); padding: 6px 9px; min-height: 46px; }
  .box:nth-child(odd) { border-right: 1px solid var(--rule); }
  .box .num { font-size: 7.5pt; color: var(--muted); }
  .box .label { font-size: 7.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
  .box .amt { font-size: 12pt; font-weight: bold; text-align: right; font-variant-numeric: tabular-nums; margin-top: 3px; }
  .notice { border: 1.5px solid var(--ink); margin-top: 12px; padding: 8px 10px; font-size: 8.5pt; }
  .notice strong { text-transform: uppercase; letter-spacing: 0.04em; }
  .instructions { margin-top: 10px; font-size: 7.5pt; color: var(--muted); line-height: 1.45; }
</style>
<div class="head">
  <div>
    <div class="agency">${esc(form.authority)}</div>
    <div style="font-size:8.5pt;color:var(--muted)">Copy B — For Recipient</div>
  </div>
  <div class="form">
    <div class="code">${esc(form.formType)}</div>
    <div class="year">${data.taxYear}</div>
    <div class="name">${esc(form.name)}</div>
  </div>
</div>

${data.corrected || data.void
  ? `<div class="flags">${data.corrected ? '<span>CORRECTED</span>' : ''}${data.void ? '<span>VOID</span>' : ''}</div>`
  : ''}

<div class="parties">
  <div>
    <div class="caption">Payer's name, address and TIN</div>
    <div class="value">${esc(data.payerName)}${data.payerAddress ? `\n${esc(data.payerAddress)}` : ''}${
      data.payerTin ? `\nTIN ${esc(data.payerTin)}` : ''
    }</div>
  </div>
  <div>
    <div class="caption">Recipient's name, address and TIN</div>
    <div class="value">${esc(data.recipientName)}${data.recipientAddress ? `\n${esc(data.recipientAddress)}` : ''}${
      data.recipientTinMasked ? `\nTIN ${esc(data.recipientTinMasked)}` : ''
    }</div>
    ${data.accountNumber ? `<div class="caption" style="margin-top:6px">Account number</div><div class="value">${esc(data.accountNumber)}</div>` : ''}
  </div>
</div>

<div class="boxes">
  ${cells
    .map(
      (cell) => `<div class="box">
        <div class="num">${esc(cell.number)}</div>
        <div class="label">${esc(cell.name)}</div>
        <div class="amt">${cell.isIndicator ? esc(cell.value) : cell.value ? `${esc(data.currency)} ${cell.value}` : ''}</div>
      </div>`,
    )
    .join('')}
</div>

<div class="notice">
  <strong>Not for filing.</strong> This is the recipient's copy, produced on a substitute form from the payer's
  books. The copy transmitted to ${esc(form.authority)} is filed through that agency's own channel; do not mail
  this page to them. If you believe an amount is wrong, contact the payer named above before filing your return.
</div>

<div class="instructions">
  Amounts shown are payments made to you in calendar ${data.taxYear} and are being reported to
  ${esc(form.authority)}. If this form shows tax withheld, claim it as a credit on your income tax return. If you
  are required to file a return and this income is not reported on it, a penalty may be imposed. Amounts are
  stated in ${esc(data.currency)}.
</div>
`
}
