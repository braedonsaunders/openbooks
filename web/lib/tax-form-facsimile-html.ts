import type { TaxReturnResult, TaxReturnBox } from '@openbooks/engine/src/tax-return.ts'

/**
 * Self-authored, form-faithful facsimiles of government indirect-tax returns —
 * the way source platform, Avalara and source platform all do it. We never redistribute the tax
 * authority's own PDF file; we render our OWN HTML that visually replicates the
 * form (agency masthead, boxed numbered line grid, section headings, signature
 * block, not-for-filing watermark) and drop the computed box values into place,
 * then print it to PDF through the shared Chromium printer. Blank functional
 * forms carry thin-to-no copyright (the "blank forms" doctrine), and this covers
 * every jurisdiction — including the API/portal-only ones that have no official
 * PDF to fill at all.
 *
 * A form with a bespoke layout in TAX_FORM_LAYOUTS renders at high fidelity; any
 * other form falls back to the generic government-return layout, so all packs
 * look like a real return out of the box.
 *
 * This module is pure (no I/O, no server-only) so the layout is unit-tested; the
 * Chromium print step lives in the server wrapper (tax-form-facsimile.ts).
 */

export interface TaxFormSection {
  /** Section heading (e.g. "NET TAX CALCULATION"); omit for an unlabelled group. */
  title?: string
  /** Box line codes, in display order, that belong to this section. */
  lineCodes: string[]
}

export interface TaxFormHeaderField {
  label: string
  /** Optional static hint/value shown in the field (e.g. a format mask). */
  value?: string
}

export interface TaxFormLayout {
  /** Tax authority masthead, e.g. "Canada Revenue Agency". */
  agency: string
  /** Secondary agency line (bilingual forms), e.g. "Agence du revenu du Canada". */
  agencySub?: string
  /** The form's own printed subtitle. */
  subtitle?: string
  /** Form's own printed identifier, e.g. "GST34-2". Defaults to the pack code. */
  formNumber?: string
  /** Identification fields printed above the line grid. */
  headerFields?: TaxFormHeaderField[]
  /** Explicit section grouping of the boxes. Boxes not named in any section are
   *  appended in their natural order under a trailing unlabelled section. */
  sections?: TaxFormSection[]
  /** Instruction / declaration notes printed under the grid. */
  footerNotes?: string[]
}

export function escFacsimile(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  )
}

/** Government forms print 2-decimal amounts with thousands separators; negatives
 *  in parentheses, and an exact zero as a plain 0.00. */
export function fmtFacsimileAmount(value: string): string {
  const n = Number(value)
  if (!Number.isFinite(n)) return escFacsimile(value)
  const abs = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return n < 0 ? `(${abs})` : abs
}

const GENERIC_FOOTER =
  'This is a working copy generated from your ledger. Verify every amount and file through the ' +
  'method the tax authority mandates. Not a certified government return.'

/**
 * Build the form body HTML for a computed return. Pure string assembly, so it is
 * cheap to unit-test and safe to render anywhere.
 */
export function renderTaxFormFacsimileHtml(
  result: TaxReturnResult,
  layout: TaxFormLayout | null,
  branding?: { orgName?: string; primaryColor?: string | null } | null,
): string {
  const accent =
    branding?.primaryColor && /^#[0-9a-fA-F]{6}$/.test(branding.primaryColor) ? branding.primaryColor : '#0f766e'
  const byCode = new Map(result.boxes.map((b) => [b.lineCode, b]))

  // Partition boxes into sections; anything not placed falls to a trailing group.
  const placed = new Set<string>()
  const sections: TaxFormSection[] = []
  for (const s of layout?.sections ?? []) {
    const present = s.lineCodes.filter((c) => byCode.has(c))
    present.forEach((c) => placed.add(c))
    if (present.length) sections.push({ title: s.title, lineCodes: present })
  }
  const leftover = result.boxes.filter((b) => !placed.has(b.lineCode)).map((b) => b.lineCode)
  if (leftover.length) sections.push({ lineCodes: leftover })

  const lineRow = (box: TaxReturnBox): string => {
    const heavy = box.computed // computed totals read as the emphasized subtotal lines
    const chipBg = heavy ? '#000000' : 'transparent'
    const chipColor = heavy ? '#ffffff' : '#0f172a'
    const amountStyle = `text-align:right;font-family:'Courier New',monospace;font-size:11px;padding:3px 8px;border:1px solid #94a3b8;min-width:120px;background:${box.editable ? '#fffef5' : '#ffffff'};${heavy ? 'font-weight:700;' : ''}`
    return `<tr>
      <td style="width:34px;padding:2px;border-bottom:1px solid #e2e8f0;">
        <div style="background:${chipBg};color:${chipColor};text-align:center;font-size:10px;font-weight:700;border:1px solid #000;padding:1px 0;">${escFacsimile(box.lineCode)}</div>
      </td>
      <td style="padding:3px 8px;border-bottom:1px solid #e2e8f0;${heavy ? 'font-weight:700;' : ''}">${escFacsimile(box.label)}${box.editable ? ' <span style="color:#94a3b8;font-size:9px;">(enter)</span>' : ''}</td>
      <td style="border-bottom:1px solid #e2e8f0;${amountStyle}">${fmtFacsimileAmount(box.value)}</td>
    </tr>`
  }

  const sectionHtml = sections
    .map((s) => {
      const head = s.title
        ? `<tr><td colspan="3" style="background:${accent};color:#fff;font-weight:700;font-size:11px;letter-spacing:.04em;padding:5px 8px;">${escFacsimile(s.title)}</td></tr>`
        : ''
      return head + s.lineCodes.map((c) => lineRow(byCode.get(c)!)).join('')
    })
    .join('')

  const headerFields = (layout?.headerFields ?? [])
    .map(
      (f) =>
        `<div style="border:1px solid #cbd5e1;padding:4px 8px;min-height:34px;">
          <div style="font-size:9px;color:#64748b;text-transform:uppercase;letter-spacing:.03em;">${escFacsimile(f.label)}</div>
          <div style="font-size:11px;color:#0f172a;font-family:'Courier New',monospace;">${escFacsimile(f.value ?? '')}</div>
        </div>`,
    )
    .join('')

  const notes = layout?.footerNotes ?? [GENERIC_FOOTER]
  const agencyLine = layout
    ? `<div style="font-size:13px;font-weight:700;color:#0f172a;">${escFacsimile(layout.agency)}</div>${
        layout.agencySub ? `<div style="font-size:11px;color:#475569;">${escFacsimile(layout.agencySub)}</div>` : ''
      }`
    : ''
  const formNumber = layout?.formNumber ?? result.formCode

  return `<div style="font-family:'Helvetica Neue',Arial,sans-serif;color:#0f172a;font-size:11px;">
    ${
      result.watermark
        ? `<div style="border:1.5px solid #b91c1c;color:#b91c1c;font-weight:700;font-size:10px;text-align:center;padding:4px;margin-bottom:10px;letter-spacing:.03em;">${escFacsimile(result.watermark)}</div>`
        : ''
    }
    <table style="width:100%;border-collapse:collapse;margin-bottom:10px;"><tr>
      <td style="vertical-align:top;">${agencyLine}
        <div style="font-size:16px;font-weight:800;margin-top:4px;">${escFacsimile(result.formName)}</div>
        ${layout?.subtitle ? `<div style="font-size:11px;color:#475569;">${escFacsimile(layout.subtitle)}</div>` : ''}
      </td>
      <td style="vertical-align:top;text-align:right;color:#475569;font-size:10px;">
        <div style="font-weight:700;color:#0f172a;">${escFacsimile(String(formNumber))}</div>
        <div>Reporting period</div>
        <div style="font-weight:700;color:#0f172a;font-family:'Courier New',monospace;">${escFacsimile(result.from)} &ndash; ${escFacsimile(result.to)}</div>
        ${branding?.orgName ? `<div style="margin-top:4px;">${escFacsimile(branding.orgName)}</div>` : ''}
      </td>
    </tr></table>
    ${headerFields ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:10px;">${headerFields}</div>` : ''}
    <table style="width:100%;border-collapse:collapse;border:1px solid #94a3b8;">
      <tr style="background:#f1f5f9;">
        <td style="width:34px;text-align:center;font-size:9px;color:#475569;padding:4px;font-weight:700;">Line</td>
        <td style="padding:4px 8px;font-size:9px;color:#475569;font-weight:700;">Description</td>
        <td style="padding:4px 8px;font-size:9px;color:#475569;font-weight:700;text-align:right;">Amount</td>
      </tr>
      ${sectionHtml}
    </table>
    <div style="margin-top:12px;color:#475569;font-size:9px;line-height:1.5;">
      ${notes.map((n) => `<div>${escFacsimile(n)}</div>`).join('')}
    </div>
    <div style="margin-top:18px;display:grid;grid-template-columns:2fr 1fr;gap:16px;">
      <div style="border-top:1px solid #94a3b8;padding-top:3px;font-size:9px;color:#64748b;">Authorized signature</div>
      <div style="border-top:1px solid #94a3b8;padding-top:3px;font-size:9px;color:#64748b;">Date</div>
    </div>
  </div>`
}

/**
 * Bespoke per-form renderers for pixel-faithful facsimiles. When a form has an
 * entry here it wins over the generic layout — this is how a GST34 comes out
 * looking like the CRA's GST34 (fixed 780px canvas, hairline-ruled box grid,
 * reversed line-number chips, Courier amounts) rather than a plain table.
 */
export type TaxFormRenderer = (
  result: TaxReturnResult,
  branding?: { orgName?: string; primaryColor?: string | null } | null,
) => string

/** Amount as the CRA/source platform worksheet prints it: thousands + forced 2 decimals,
 *  absolute value (the sign shows in a separate box on signed lines). */
function fmtGrid(n: number): string {
  return Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Faithful GST34 worksheet, modelled directly on source platform's clone of the CRA
 * form: a fixed 780px canvas, three-column ruled rows (label · line-number chip ·
 * Courier amount box), reversed white-on-black chips for principal/total lines
 * and plain chips for the additive sub-inputs, a sign box on the NET TAX/BALANCE
 * lines, and the CRA section headings and instruction text verbatim.
 */
export function renderGst34Facsimile(
  result: TaxReturnResult,
  branding?: { orgName?: string; primaryColor?: string | null } | null,
): string {
  const v = (code: string): number => {
    const b = result.boxes.find((x) => x.lineCode === code)
    return b ? Number(b.value) : 0
  }
  const isEditable = (code: string): boolean =>
    result.boxes.find((x) => x.lineCode === code)?.editable ?? false

  const box = (n: number, editable = false) =>
    `<td style="width:150px;border:1px solid #000;border-left:none;padding:3px 6px;text-align:right;font-family:'Courier New',monospace;font-size:11px;background:${editable ? '#fffef5' : '#fff'};">${fmtGrid(n)}</td>`
  const chip = (code: string, reversed: boolean) =>
    `<td style="width:30px;padding:0 3px;text-align:center;vertical-align:middle;"><div style="border:1px solid #000;background:${reversed ? '#000' : '#fff'};color:${reversed ? '#fff' : '#000'};font-weight:700;font-size:11px;padding:1px 0;">${code}</div></td>`
  const signCell = (n: number) =>
    `<td style="width:16px;text-align:center;font-weight:700;font-family:'Courier New',monospace;">${n < 0 ? '&minus;' : ''}</td>`

  // A standard line: label box (left) · chip · amount box.
  const line = (label: string, code: string, opts?: { reversed?: boolean }) =>
    `<tr>
      <td style="border:1px solid #000;padding:3px 6px;font-size:10px;line-height:1.35;">${label}</td>
      <td style="width:16px;"></td>
      ${chip(code, opts?.reversed ?? false)}
      ${box(v(code), isEditable(code))}
    </tr>`
  // A subtotal line: right-aligned caption spanning the label column.
  const subtotal = (caption: string, code: string) =>
    `<tr>
      <td style="border:none;padding:3px 6px;font-size:9px;text-align:right;color:#111;">${caption}</td>
      <td style="width:16px;"></td>
      ${chip(code, true)}
      ${box(v(code))}
    </tr>`
  // NET TAX / BALANCE line: bold title + caption, with a sign box before the chip.
  const balance = (title: string, caption: string, code: string) =>
    `<tr>
      <td style="border:1px solid #000;padding:3px 6px;font-size:10px;"><span style="font-weight:700;font-size:11px;">${title}</span> <span style="font-size:9px;">${caption}</span></td>
      ${signCell(v(code))}
      ${chip(code, true)}
      ${box(v(code))}
    </tr>`
  const sectionHead = (title: string) =>
    `<tr><td colspan="4" style="padding:8px 4px 3px;font-size:12px;font-weight:700;">&nbsp;&nbsp;${title}</td></tr>`
  const note = (text: string) =>
    `<tr><td colspan="4" style="padding:1px 6px 4px;font-size:9px;color:#333;"><strong>NOTE:</strong> ${text}</td></tr>`

  const period = `${result.from} &nbsp;&nbsp; ${result.to}`
  const bn = '00000 0000 000000'

  return `<div style="width:780px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;color:#000;">
    ${
      result.watermark
        ? `<div style="border:1.5px solid #b91c1c;color:#b91c1c;font-weight:700;font-size:10px;text-align:center;padding:4px;margin-bottom:8px;">${escFacsimile(result.watermark)}</div>`
        : ''
    }
    <table style="width:100%;border-collapse:collapse;margin-bottom:6px;"><tr>
      <td style="vertical-align:top;font-weight:700;font-size:11px;line-height:1.3;">
        Canada Revenue Agency<br><span style="font-weight:400;">Agence du revenu du Canada</span>
      </td>
      <td style="vertical-align:top;text-align:right;font-size:9px;">GST34-2</td>
    </tr></table>
    <div style="text-align:center;font-size:13px;font-weight:700;margin-bottom:8px;line-height:1.3;">
      GOODS AND SERVICES TAX / HARMONIZED SALES TAX (GST/HST)<br>RETURN FOR REGISTRANTS
    </div>
    <table style="width:100%;border-collapse:collapse;margin-bottom:8px;font-size:10px;">
      <tr>
        <td style="border:1px solid #000;padding:4px 6px;width:50%;">Business Number<br><span style="font-family:'Courier New',monospace;font-size:11px;">${escFacsimile(bn)}</span></td>
        <td style="border:1px solid #000;border-left:none;padding:4px 6px;">Name<br><span style="font-family:'Courier New',monospace;font-size:11px;">${escFacsimile(branding?.orgName ?? '')}</span></td>
      </tr>
      <tr>
        <td colspan="2" style="border:1px solid #000;border-top:none;padding:4px 6px;">
          <span style="background:#000;color:#fff;font-weight:700;padding:0 4px;">Part 1</span>
          &nbsp;&nbsp;Reporting period&nbsp;&nbsp;<span style="font-family:'Courier New',monospace;font-size:11px;">${period}</span>
        </td>
      </tr>
    </table>
    <table style="width:100%;border-collapse:collapse;">
      ${line('Enter your total <strong>sales and other revenue.</strong> Do not include provincial sales tax, GST or HST. If you are using the Quick Method of accounting, include the GST or HST.', '101', { reversed: true })}
      ${sectionHead('NET TAX CALCULATION')}
      ${line('Enter the total of all <strong>GST and HST amounts that you collected or that became collectible</strong> by you in the reporting period.', '103')}
      ${line('Enter the total amount of <strong>adjustments</strong> to be added to the net tax for the reporting period (e.g., GST/HST obtained from the recovery of a bad debt).', '104')}
      ${subtotal('Total GST/HST and adjustments (add lines 103 and 104)', '105')}
      ${line('Enter the GST/HST you paid or owe on qualifying expenses <strong>(input tax credits &ndash; ITCs)</strong> for the current period and any eligible unclaimed ITCs from a previous period.', '106')}
      ${line('Enter the total amount of <strong>adjustments</strong> to be deducted when determining the net tax for the reporting period (e.g., GST/HST included in a bad debt).', '107')}
      ${subtotal('Total ITCs and adjustments (add lines 106 and 107)', '108')}
      ${balance('NET TAX', '(subtract line 108 from line 105). If the result is negative, enter a minus sign in the box next to the line number.', '109')}
      ${sectionHead('OTHER CREDITS IF APPLICABLE')}
      ${note('Do not complete line 111 until you have read the instructions on the reverse side of this return.')}
      ${line('Enter any <strong>instalment and other annual filer payments</strong> you made for the reporting period.', '110', { reversed: true })}
      ${line('Enter the total amount of the GST/HST <strong>rebates</strong>, only if the rebate form indicates that you can claim the amount on this line. Attach the rebate form to this return.', '111', { reversed: true })}
      ${subtotal('Total other credits (add lines 110 and 111)', '112')}
      ${balance('BALANCE', '(subtract line 112 from line 109). If the result is negative, enter a minus sign in the box next to the line number.', '113A')}
      ${sectionHead('OTHER DEBITS IF APPLICABLE')}
      ${note('Do not complete line 205 or line 405 until you have read the instructions on the reverse side of this return.')}
      ${line('Enter the total amount of the <strong>GST/HST due on the acquisition of taxable real property.</strong>', '205', { reversed: true })}
      ${line('Enter the total amount of <strong>other GST/HST to be self-assessed.</strong>', '405', { reversed: true })}
      ${subtotal('Total other debits (add lines 205 and 405)', '113B')}
      ${balance('BALANCE', '(add lines 113A and 113B). If the result is negative, enter a minus sign in the box next to the line number.', '113C')}
    </table>
    <table style="width:100%;border-collapse:collapse;margin-top:10px;text-align:center;"><tr>
      <td style="width:50%;padding:4px;">
        <div style="font-weight:700;font-size:10px;">REFUND CLAIMED &nbsp;&#9660;</div>
        <table style="width:100%;border-collapse:collapse;margin-top:2px;"><tr>${chip('114', true)}${box(v('114'))}</tr></table>
      </td>
      <td style="width:50%;padding:4px;">
        <div style="font-weight:700;font-size:10px;">PAYMENT ENCLOSED &nbsp;&#9660;</div>
        <table style="width:100%;border-collapse:collapse;margin-top:2px;"><tr>${chip('115', true)}${box(v('115'))}</tr></table>
      </td>
    </tr></table>
    <div style="margin-top:8px;font-size:8px;color:#333;">GST34-1 E (02)</div>
    <div style="margin-top:6px;font-size:8px;color:#666;">${escFacsimile(result.watermark ?? '')}</div>
  </div>`
}

export const TAX_FORM_RENDERERS: Record<string, TaxFormRenderer> = {
  CA_GST34: renderGst34Facsimile,
}

/**
 * Single entry point: use a bespoke renderer when the form has one, else the
 * generic government-return layout. Used by the server PDF wrapper and by tests.
 */
export function renderTaxFormFacsimileBody(
  result: TaxReturnResult,
  branding?: { orgName?: string; primaryColor?: string | null } | null,
): string {
  const bespoke = TAX_FORM_RENDERERS[result.formCode]
  if (bespoke) return bespoke(result, branding)
  return renderTaxFormFacsimileHtml(result, TAX_FORM_LAYOUTS[result.formCode] ?? null, branding)
}

/**
 * High-fidelity per-form layouts. Forms absent from this map still render via the
 * generic government-return layout. Kept as data so a new form is a table entry,
 * not code — matching the "jurisdictions are DATA" doctrine.
 */
export const TAX_FORM_LAYOUTS: Record<string, TaxFormLayout> = {
  CA_GST34: {
    agency: 'Canada Revenue Agency',
    agencySub: 'Agence du revenu du Canada',
    subtitle: 'Goods and Services Tax / Harmonized Sales Tax (GST/HST) — Return for registrants',
    formNumber: 'GST34-2',
    headerFields: [
      { label: 'Business Number' },
      { label: 'Legal name' },
      { label: 'Reporting period — from / to' },
      { label: 'Due date' },
    ],
    sections: [
      { title: 'SALES AND REVENUE', lineCodes: ['101'] },
      { title: 'NET TAX CALCULATION', lineCodes: ['103', '104', '105', '106', '107', '108', '109'] },
      { title: 'OTHER CREDITS IF APPLICABLE', lineCodes: ['110', '111', '112', '113A'] },
      { title: 'OTHER DEBITS IF APPLICABLE', lineCodes: ['205', '405', '113B', '113C'] },
      { title: 'REFUND OR PAYMENT', lineCodes: ['114', '115'] },
    ],
    footerNotes: [
      'Do not complete line 205 or line 405 until you have read the instructions on the back of the return.',
      'Working copy — file electronically through the CRA. Not a government return.',
    ],
  },
}
