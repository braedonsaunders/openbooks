import type { TaxReturnResult } from '@openbooks/engine/src/tax-return.ts'
import { TAX_FORM_LAYOUTS, type TaxFormLayout } from './tax-form-facsimile-html'

/**
 * Structured (machine-readable) export of a computed return — the shape source platform
 * ships for India GSTR filing, where the deliverable is data, not a printed form:
 * the return is filed by uploading JSON to the portal (via the government offline
 * tool) rather than looking at a facsimile. This emits the computed boxes grouped
 * into the return's sections, so it reconciles line-for-line against the portal.
 *
 * It is a WORKING COPY for reconciliation, not a certified filing artefact — it
 * deliberately carries no GSTIN/registration credentials and is not the exact
 * government JSON schema; map it into the portal/offline tool before submitting.
 *
 * Pure (no I/O) so the transform is unit-tested.
 */

export interface StructuredReturnBox {
  line: string
  label: string
  /** Numeric value at ledger precision (not a formatted string). */
  value: number
  computed: boolean
  editable: boolean
}

export interface StructuredReturnSection {
  title: string | null
  boxes: StructuredReturnBox[]
}

export interface StructuredReturn {
  form: {
    code: string
    name: string
    submissionChannel: string
  }
  period: { from: string; to: string }
  sections: StructuredReturnSection[]
  /** The headline net/payable line, surfaced for convenience. */
  net: { line: string; label: string; value: number } | null
  /** Every box flat, in order — for consumers that don't care about sections. */
  boxes: StructuredReturnBox[]
  basis: 'working-copy'
  notice: string | null
}

/** Line codes that name the headline net/payable/refund box, most-specific first. */
const NET_LINE_CODES = ['113C', '6.1', '109', '28', '46', '20', '14', '8', '9', '5', '15', '5g', '83', '21', 'TAX_DUE']

function toBox(b: TaxReturnResult['boxes'][number]): StructuredReturnBox {
  return { line: b.lineCode, label: b.label, value: Number(b.value), computed: b.computed, editable: b.editable }
}

/** Transform a computed return into the structured export shape, grouping boxes
 *  by the form's facsimile sections when a layout exists. */
export function taxReturnToStructured(result: TaxReturnResult, layout?: TaxFormLayout | null): StructuredReturn {
  const resolved = layout ?? TAX_FORM_LAYOUTS[result.formCode] ?? null
  const byCode = new Map(result.boxes.map((b) => [b.lineCode, b]))

  const placed = new Set<string>()
  const sections: StructuredReturnSection[] = []
  for (const s of resolved?.sections ?? []) {
    const present = s.lineCodes.filter((c) => byCode.has(c))
    present.forEach((c) => placed.add(c))
    if (present.length) sections.push({ title: s.title ?? null, boxes: present.map((c) => toBox(byCode.get(c)!)) })
  }
  const leftover = result.boxes.filter((b) => !placed.has(b.lineCode))
  if (leftover.length) sections.push({ title: null, boxes: leftover.map(toBox) })

  const netCode = NET_LINE_CODES.find((c) => byCode.has(c))
  const netBox = netCode ? byCode.get(netCode)! : undefined

  return {
    form: { code: result.formCode, name: result.formName, submissionChannel: result.submissionChannel },
    period: { from: result.from, to: result.to },
    sections,
    net: netBox ? { line: netBox.lineCode, label: netBox.label, value: Number(netBox.value) } : null,
    boxes: result.boxes.map(toBox),
    basis: 'working-copy',
    notice: result.watermark,
  }
}

export function taxReturnToJsonString(result: TaxReturnResult, layout?: TaxFormLayout | null): string {
  return JSON.stringify(taxReturnToStructured(result, layout), null, 2)
}
