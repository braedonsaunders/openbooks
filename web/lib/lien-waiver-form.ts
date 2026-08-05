/**
 * Lien-waiver forms — self-authored, statute-shaped facsimiles.
 *
 * Same doctrine as the tax-return facsimiles (web/lib/tax-form-facsimile-html.ts):
 * we never redistribute a jurisdiction's own PDF. We render our OWN document
 * that carries the operative language of the four standard waiver types, with a
 * printed notice naming the statute the form follows and a signature/notary
 * block. Blank functional forms carry thin-to-no copyright, and this covers the
 * jurisdictions that publish no fillable form at all.
 *
 * The four types are not cosmetic variants — they differ in what they release
 * and when:
 *
 *   conditional_progress     releases work through a date, EFFECTIVE ONLY once
 *                            the payment actually clears.
 *   unconditional_progress   releases work through a date immediately, whether
 *                            or not the cheque clears. The dangerous one.
 *   conditional_final        releases the entire contract, on payment clearing.
 *   unconditional_final      releases the entire contract, immediately.
 *
 * This module is pure so the wording is unit-testable; the Chromium print step
 * lives in the server wrapper (web/lib/lien-waiver-pdf.ts).
 */

export type LienWaiverType =
  | 'conditional_progress'
  | 'unconditional_progress'
  | 'conditional_final'
  | 'unconditional_final'

export interface LienWaiverFormData {
  waiverNumber: string
  waiverType: LienWaiverType
  direction: 'received' | 'issued'
  /** The party giving up lien rights (the subcontractor, or us when issuing). */
  claimantName: string
  /** Who is paying (us when receiving, the owner/GC when issuing). */
  payerName: string
  /** Owner of the improved property, when known. */
  ownerName?: string | null
  projectName: string
  projectAddress?: string | null
  throughDate: string
  amount: string
  currency: string
  jurisdiction?: string | null
  billNumber?: string | null
  notes?: string | null
  signedByName?: string | null
  signedByTitle?: string | null
  signedAt?: string | null
  notarized: boolean
  /** Signature evidence to print as an audit line (token id, IP, method). */
  signatureEvidence?: string | null
}

export function esc(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

export function formatWaiverAmount(amount: string, currency: string): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return `${esc(currency)} ${esc(amount)}`
  return `${esc(currency)} ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export interface WaiverTypeCopy {
  title: string
  /** One-line description used in lists and drawers. */
  summary: string
  /** The operative release paragraph. */
  operative: (data: LienWaiverFormData) => string
  /** Statutory-style caution printed in a boxed notice. */
  notice: string
  isConditional: boolean
  isFinal: boolean
}

const scope = (data: LienWaiverFormData) =>
  `labor, services, equipment, and material furnished to the property described below through ${esc(
    data.throughDate,
  )}`

export const WAIVER_TYPE_COPY: Record<LienWaiverType, WaiverTypeCopy> = {
  conditional_progress: {
    title: 'Conditional Waiver and Release on Progress Payment',
    summary: 'Releases work through a date, effective only when the payment clears.',
    isConditional: true,
    isFinal: false,
    operative: (data) =>
      `Upon receipt by the undersigned of a check or other payment in the sum of ${formatWaiverAmount(
        data.amount,
        data.currency,
      )} payable to the undersigned, and when the check or payment has been properly endorsed and has been paid ` +
      `by the financial institution on which it is drawn, this document becomes effective to release and does ` +
      `release any mechanic's lien, stop payment notice, or payment bond right the undersigned has for ${scope(data)}. ` +
      `This release covers a progress payment only and does not cover any retention, pending modifications, ` +
      `items furnished after that date, or contract rights that have not yet accrued.`,
    notice:
      'This is a CONDITIONAL release. It takes effect only after the payment described above has actually been ' +
      'honoured by the paying bank. If the payment is not honoured, this document releases nothing.',
  },
  unconditional_progress: {
    title: 'Unconditional Waiver and Release on Progress Payment',
    summary: 'Releases work through a date immediately, whether or not payment clears.',
    isConditional: false,
    isFinal: false,
    operative: (data) =>
      `The undersigned has been paid and has received a progress payment in the sum of ${formatWaiverAmount(
        data.amount,
        data.currency,
      )} for ${scope(data)}, and does hereby release any mechanic's lien, stop payment notice, or payment bond ` +
      `right the undersigned has for that work. This release covers a progress payment only and does not cover ` +
      `any retention, pending modifications, items furnished after that date, or contract rights that have not ` +
      `yet accrued.`,
    notice:
      'This is an UNCONDITIONAL release. The undersigned loses the rights described above even if the payment ' +
      'referred to is never received or is not honoured. Do not sign this document until payment has actually ' +
      'been received and cleared.',
  },
  conditional_final: {
    title: 'Conditional Waiver and Release on Final Payment',
    summary: 'Releases the entire contract, effective only when final payment clears.',
    isConditional: true,
    isFinal: true,
    operative: (data) =>
      `Upon receipt by the undersigned of a check or other payment in the sum of ${formatWaiverAmount(
        data.amount,
        data.currency,
      )} payable to the undersigned, and when the check or payment has been properly endorsed and has been paid ` +
      `by the financial institution on which it is drawn, this document becomes effective to release and does ` +
      `release any mechanic's lien, stop payment notice, or payment bond right the undersigned has on the ` +
      `property described below, including all retention withheld, for all ${scope(data)}.`,
    notice:
      'This is a CONDITIONAL FINAL release. On payment clearing it releases EVERY remaining claim on this ' +
      'project, including retention. Confirm that all change orders, back charges and retention have been ' +
      'settled before signing.',
  },
  unconditional_final: {
    title: 'Unconditional Waiver and Release on Final Payment',
    summary: 'Releases the entire contract immediately, whether or not payment clears.',
    isConditional: false,
    isFinal: true,
    operative: (data) =>
      `The undersigned has been paid in full for all ${scope(data)}, in the total sum of ${formatWaiverAmount(
        data.amount,
        data.currency,
      )}, and does hereby waive and release any right to a mechanic's lien, stop payment notice, or any right ` +
      `against a labor and material bond on the property described below, including all retention withheld.`,
    notice:
      'This is an UNCONDITIONAL FINAL release. The undersigned gives up EVERY remaining claim on this project, ' +
      'including retention, even if the final payment is never received. Do not sign this document until final ' +
      'payment has actually been received and cleared.',
  },
}

export function waiverTypeCopy(waiverType: string): WaiverTypeCopy {
  const copy = WAIVER_TYPE_COPY[waiverType as LienWaiverType]
  if (!copy) throw new Error(`unknown lien waiver type "${waiverType}"`)
  return copy
}

const FIELD = (label: string, value: string | null | undefined) => `
  <tr>
    <th>${esc(label)}</th>
    <td>${value ? esc(value) : '<span class="blank"></span>'}</td>
  </tr>`

/**
 * The printable body. Renders the same document whether the waiver is still a
 * blank to be signed or already executed: an unsigned waiver prints rule lines
 * to sign on, an executed one prints the captured signature and its evidence.
 */
export function renderLienWaiverBody(data: LienWaiverFormData, orgName?: string | null): string {
  const copy = waiverTypeCopy(data.waiverType)
  const executed = Boolean(data.signedAt && data.signedByName)
  return `
<style>
  :root { --ink: #0f172a; --muted: #64748b; --rule: #cbd5e1; }
  * { box-sizing: border-box; }
  body { font-family: "Times New Roman", Times, Georgia, serif; color: var(--ink); font-size: 11pt; line-height: 1.5; margin: 0; }
  .masthead { border-bottom: 2px solid var(--ink); padding-bottom: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: flex-end; }
  .masthead h1 { font-size: 14pt; margin: 0; text-transform: uppercase; letter-spacing: 0.02em; }
  .masthead .meta { text-align: right; font-size: 9pt; color: var(--muted); }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.08em; margin: 16px 0 6px; border-bottom: 1px solid var(--rule); padding-bottom: 3px; }
  table.fields { width: 100%; border-collapse: collapse; }
  table.fields th { width: 27%; text-align: left; font-weight: normal; color: var(--muted); font-size: 9.5pt; padding: 4px 8px 4px 0; vertical-align: top; }
  table.fields td { border-bottom: 1px solid var(--rule); padding: 4px 0; }
  .blank { display: inline-block; min-width: 60%; border-bottom: 1px solid var(--rule); height: 1em; }
  .operative { margin: 10px 0; text-align: justify; }
  .notice { border: 1.5px solid var(--ink); padding: 9px 11px; margin: 14px 0; font-size: 9.5pt; }
  .notice strong { text-transform: uppercase; letter-spacing: 0.04em; }
  .amount { font-size: 13pt; font-weight: bold; }
  .sig { margin-top: 22px; display: flex; gap: 28px; }
  .sig > div { flex: 1; }
  .sigline { border-bottom: 1px solid var(--ink); height: 2.2em; margin-bottom: 3px; }
  .siglabel { font-size: 8.5pt; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; }
  .executed { font-family: "Segoe Script", "Brush Script MT", cursive; font-size: 15pt; padding-bottom: 2px; }
  .notary { border: 1px solid var(--rule); padding: 10px; margin-top: 18px; font-size: 9pt; color: var(--muted); }
  .evidence { margin-top: 12px; font-size: 8pt; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .footnote { margin-top: 16px; font-size: 8pt; color: var(--muted); border-top: 1px solid var(--rule); padding-top: 6px; }
</style>
<div class="masthead">
  <h1>${esc(copy.title)}</h1>
  <div class="meta">
    ${esc(data.waiverNumber)}<br />
    ${data.jurisdiction ? `Form follows ${esc(data.jurisdiction)}<br />` : ''}
    ${orgName ? esc(orgName) : ''}
  </div>
</div>

<h2>Identification</h2>
<table class="fields">
  ${FIELD('Claimant (releasing party)', data.claimantName)}
  ${FIELD('Payer', data.payerName)}
  ${FIELD('Property owner', data.ownerName)}
  ${FIELD('Project', data.projectName)}
  ${FIELD('Property / job address', data.projectAddress)}
  ${FIELD('Through date', data.throughDate)}
  ${data.billNumber ? FIELD('Invoice covered', data.billNumber) : ''}
</table>

<h2>Amount ${copy.isConditional ? 'of payment' : 'received'}</h2>
<p class="amount">${formatWaiverAmount(data.amount, data.currency)}</p>

<h2>Release</h2>
<p class="operative">${copy.operative(data)}</p>

<div class="notice"><strong>Notice:</strong> ${esc(copy.notice)}</div>

${data.notes ? `<h2>Exceptions and disputed claims</h2><p class="operative">${esc(data.notes)}</p>` : ''}

<div class="sig">
  <div>
    ${executed
      ? `<div class="sigline executed">${esc(data.signedByName!)}</div>`
      : '<div class="sigline"></div>'}
    <div class="siglabel">Signature of claimant's authorised representative</div>
  </div>
  <div>
    ${executed && data.signedAt ? `<div class="sigline">${esc(data.signedAt.slice(0, 10))}</div>` : '<div class="sigline"></div>'}
    <div class="siglabel">Date</div>
  </div>
</div>
<div class="sig">
  <div>
    ${executed && data.signedByName ? `<div class="sigline">${esc(data.signedByName)}</div>` : '<div class="sigline"></div>'}
    <div class="siglabel">Printed name</div>
  </div>
  <div>
    ${executed && data.signedByTitle ? `<div class="sigline">${esc(data.signedByTitle)}</div>` : '<div class="sigline"></div>'}
    <div class="siglabel">Title</div>
  </div>
</div>

${data.notarized
  ? `<div class="notary">
       <strong>Notary acknowledgement</strong><br />
       State/Province of <span class="blank"></span> County of <span class="blank"></span><br /><br />
       Subscribed and sworn before me this <span class="blank"></span> day of <span class="blank"></span>,
       by the person named above, proved to me on the basis of satisfactory evidence to be the person who
       appeared before me.<br /><br />
       Notary signature <span class="blank"></span> Seal <span class="blank"></span>
     </div>`
  : ''}

${data.signatureEvidence
  ? `<div class="evidence">Electronic signature evidence — ${esc(data.signatureEvidence)}</div>`
  : ''}

<div class="footnote">
  Generated by ${orgName ? esc(orgName) : 'openbooks'} from its project records. This form reproduces the
  operative language of a ${esc(copy.title.toLowerCase())}${data.jurisdiction ? ` under ${esc(data.jurisdiction)}` : ''};
  it is not a government-issued form. Have counsel confirm the wording your jurisdiction requires before use.
</div>
`
}
