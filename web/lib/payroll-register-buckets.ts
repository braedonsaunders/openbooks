import { decimalAdd, decimalIsZero } from './statement-format.ts'

/**
 * Pack-declared payroll register buckets (F-t08-012).
 *
 * The run review grid and stub header used to summarize every run into
 * hardcoded Canadian buckets (PROVINCE/CPP/EI/TAX read off CA factor keys),
 * so a US run showed TAX $0.00 while its withholding hid in the pay lines.
 * Columns now come from the installed packs' statutory component
 * declarations: labels and order from the declarations, presence from the
 * run's own nonzero deduction lines. The declarations are passed in (rather
 * than imported from the engine pack registry, which pulls the database)
 * so this module stays importable from client components and unit tests.
 */
export interface BucketDeclaration {
  /** pay_components.code, e.g. FIT, SS, TAX, CPP. */
  code: string
  /** Pack component name — the column label, e.g. Federal income tax. */
  label: string
  /** Pack component sequence — the column order. */
  sequence: number
}

export interface BucketLine {
  componentCode: string | null
  kind: string
  amount: string
}

export interface RegisterBucket {
  code: string
  label: string
}

const keyOf = (code: string): string => code.toUpperCase()

/** Declared buckets with a nonzero deduction line in the run, in pack order. */
export function buildRegisterBuckets(
  lines: readonly BucketLine[],
  declared: readonly BucketDeclaration[],
): RegisterBucket[] {
  const present = new Set<string>()
  for (const line of lines) {
    if (line.kind !== 'deduction' || !line.componentCode) continue
    if (decimalIsZero(line.amount)) continue
    present.add(keyOf(line.componentCode))
  }
  return declared
    .filter((d) => present.has(keyOf(d.code)))
    .sort((a, b) => a.sequence - b.sequence || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
    .map(({ code, label }) => ({ code, label }))
}

/** Per-bucket totals for one stub: its deduction lines summed by bucket code. */
export function bucketAmounts(
  lines: readonly BucketLine[],
  buckets: readonly RegisterBucket[],
): string[] {
  return buckets.map(({ code }) => {
    let total = '0'
    for (const line of lines) {
      if (line.kind !== 'deduction') continue
      if ((line.componentCode ?? '').toUpperCase() !== keyOf(code)) continue
      total = decimalAdd(total, line.amount)
    }
    return total
  })
}
