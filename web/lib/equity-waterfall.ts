import type { WaterfallResult } from '@openbooks/engine/equity'
import { add, cmp, isZero, mulDecimal, neg, sum, toUnits } from '@openbooks/engine/money/money'

/**
 * The exit waterfall as the page draws it: preset exit values around the
 * latest priced round, the proceeds in the order they are paid, the payout
 * lines by recipient, each elector's choice with the amounts that decided
 * it, and the proceeds of each recipient across exit values. Every amount
 * stays an exact four-place decimal string; sums use the ledger arithmetic.
 */

/**
 * The exit a waterfall opens on: the post-money valuation (pre-money plus the
 * round's new money) of the latest priced round closed by the date in the
 * legal entity's functional currency. None when no such round exists; the
 * page then asks for an exit value rather than inventing one.
 */
export function defaultExitAnchor(
  rounds: readonly { name: string; closedOn: string; currency: string; preMoneyValuation: string; raised: string }[],
  asOf: string,
  currency: string,
): { roundName: string; closedOn: string; postMoney: string } | null {
  const latest = rounds
    .filter((round) => round.closedOn <= asOf && round.currency === currency)
    .reduce<(typeof rounds)[number] | null>((best, round) => (best === null || round.closedOn > best.closedOn ? round : best), null)
  return latest ? { roundName: latest.name, closedOn: latest.closedOn, postMoney: add(latest.preMoneyValuation, latest.raised) } : null
}

/** Multiples of the latest post-money valuation offered as one-click exit values. */
export const EXIT_PRESET_MULTIPLES = ['0.5', '1', '2', '5'] as const

export function exitPresets(postMoney: string | null): { multiple: string; value: string }[] {
  if (!postMoney || cmp(postMoney, '0') <= 0) return []
  return EXIT_PRESET_MULTIPLES.map((multiple) => ({ multiple, value: mulDecimal(postMoney, multiple) }))
}

export type RecipientKey = `class:${string}` | 'awards' | 'safes' | 'notes' | 'unallocated'

/** One step of the distribution, in payment order: fees, notes, preferences by seniority, then the residual. */
export interface WaterfallStep {
  key: string
  kind: 'fees' | 'notes' | 'preference' | 'safe_cash_out' | 'participation' | 'safe_conversion' | 'awards' | 'unallocated'
  code: string | null
  amount: string
}

const payoutTotal = (result: WaterfallResult, kind: 'award' | 'note' | 'safe'): string =>
  sum(result.payouts.filter((row) => row.kind === kind).map((row) => row.amount))

/** The proceeds in the order the waterfall pays them. Zero steps are left out; the steps sum to the exit value plus fees. */
export function waterfallSteps(result: WaterfallResult, transactionFees: string): WaterfallStep[] {
  const steps: WaterfallStep[] = []
  const push = (step: WaterfallStep) => { if (!isZero(step.amount)) steps.push(step) }
  push({ key: 'fees', kind: 'fees', code: null, amount: transactionFees })
  push({ key: 'notes', kind: 'notes', code: null, amount: payoutTotal(result, 'note') })
  const preferred = result.classes.filter((row) => row.kind === 'preferred').sort((a, b) => b.seniority - a.seniority || (a.code < b.code ? -1 : 1))
  for (const row of preferred) {
    if (!row.converted) push({ key: `preference:${row.shareClassId}`, kind: 'preference', code: row.code, amount: cmp(row.preference, row.total) > 0 ? row.total : row.preference })
  }
  const cashOut = sum(result.safes.filter((row) => !row.converted).map((row) => row.amount))
  push({ key: 'safe_cash_out', kind: 'safe_cash_out', code: null, amount: cashOut })
  for (const row of [...preferred, ...result.classes.filter((candidate) => candidate.kind !== 'preferred')]) {
    // The residual share is the class total less any preference already shown, so the steps stay exact.
    const residual = row.converted || row.kind !== 'preferred' ? row.total : add(row.total, neg(cmp(row.preference, row.total) > 0 ? row.total : row.preference))
    push({ key: `participation:${row.shareClassId}`, kind: 'participation', code: row.code, amount: residual })
  }
  push({ key: 'safe_conversion', kind: 'safe_conversion', code: null, amount: sum(result.safes.filter((row) => row.converted).map((row) => row.amount)) })
  push({ key: 'awards', kind: 'awards', code: null, amount: payoutTotal(result, 'award') })
  push({ key: 'unallocated', kind: 'unallocated', code: null, amount: result.unallocated })
  return steps
}

export interface PayoutLine {
  key: RecipientKey
  shareClassId: string | null
  code: string | null
  converted: boolean | null
  preference: string | null
  participation: string | null
  total: string
  perShare: string | null
  percent: string
}

/** A part of a whole as a two-place percentage, rounded half up, in exact integer arithmetic. */
export function percentOf(part: string, whole: string): string {
  const total = toUnits(whole)
  if (total <= 0n) return '0.00'
  const basisPoints = (toUnits(part) * 20000n + total) / (2n * total)
  const sign = basisPoints < 0n ? '-' : ''
  const magnitude = basisPoints < 0n ? -basisPoints : basisPoints
  return `${sign}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, '0')}`
}

/** Payout lines by recipient: each share class, then awards, SAFEs, notes and anything unallocated. They sum to the proceeds. */
export function payoutLines(result: WaterfallResult): PayoutLine[] {
  const proceeds = result.exitValue
  const lines: PayoutLine[] = result.classes.map((row) => ({
    key: `class:${row.shareClassId}` as const, shareClassId: row.shareClassId, code: row.code,
    converted: row.kind === 'preferred' ? row.converted : null,
    preference: row.kind === 'preferred' ? row.preference : null, participation: row.participation,
    total: row.total, perShare: row.perShare, percent: percentOf(row.total, proceeds),
  }))
  for (const [key, kind] of [['awards', 'award'], ['safes', 'safe'], ['notes', 'note']] as const) {
    const total = payoutTotal(result, kind)
    const present = result.payouts.some((row) => row.kind === kind)
    if (present) lines.push({ key, shareClassId: null, code: null, converted: null, preference: null, participation: null, total, perShare: null, percent: percentOf(total, proceeds) })
  }
  if (!isZero(result.unallocated)) {
    lines.push({ key: 'unallocated', shareClassId: null, code: null, converted: null, preference: null, participation: null, total: result.unallocated, perShare: null, percent: percentOf(result.unallocated, proceeds) })
  }
  return lines
}

/** Why each elector was paid what it was: its choice and the amount the other choice would have paid. */
export interface ConversionDecision {
  key: string
  subject: 'class' | 'safe'
  shareClassId: string | null
  securityId: string | null
  code: string | null
  holderPartyId: string | null
  decision: 'converts' | 'keeps_preference' | 'participates' | 'participates_capped' | 'safe_converts' | 'safe_cash_out'
  amount: string
  /** The class's liquidation preference, or a SAFE's cash-out amount. */
  entitlement: string
  alternative: string | null
  cap: string | null
}

export function conversionDecisions(result: WaterfallResult): ConversionDecision[] {
  const classes = result.classes
    .filter((row) => row.kind === 'preferred')
    .sort((a, b) => b.seniority - a.seniority || (a.code < b.code ? -1 : 1))
    .map((row): ConversionDecision => ({
      key: `class:${row.shareClassId}`, subject: 'class', shareClassId: row.shareClassId, securityId: null, code: row.code, holderPartyId: null,
      decision: row.converted ? 'converts' : row.participationMode === 'full' ? 'participates' : row.participationMode === 'capped' ? 'participates_capped' : 'keeps_preference',
      amount: row.total, entitlement: row.preferenceEntitlement, alternative: row.alternativeTotal, cap: row.participationCap,
    }))
  const safes = result.safes.map((row): ConversionDecision => ({
    key: `safe:${row.securityId}`, subject: 'safe', shareClassId: null, securityId: row.securityId, code: null, holderPartyId: row.holderPartyId,
    decision: row.converted ? 'safe_converts' : 'safe_cash_out', amount: row.amount, entitlement: row.cashOutAmount, alternative: row.alternativeAmount, cap: null,
  }))
  return [...classes, ...safes]
}

export interface CurveSeries {
  key: RecipientKey
  code: string | null
  data: string[]
}

/** Each recipient's proceeds across the curve's exit values; recipients paid nothing anywhere are left out. */
export function curveSeries(curve: readonly { exitValue: string; result: WaterfallResult }[]): { exitValues: string[]; series: CurveSeries[] } {
  const exitValues = curve.map((point) => point.exitValue)
  const first = curve[curve.length - 1]?.result ?? curve[0]?.result
  if (!first) return { exitValues, series: [] }
  const ordered = [
    ...first.classes.filter((row) => row.kind === 'preferred').sort((a, b) => b.seniority - a.seniority || (a.code < b.code ? -1 : 1)),
    ...first.classes.filter((row) => row.kind !== 'preferred'),
  ]
  const series: CurveSeries[] = [
    ...ordered.map((row) => ({
      key: `class:${row.shareClassId}` as const, code: row.code,
      data: curve.map((point) => point.result.classes.find((candidate) => candidate.shareClassId === row.shareClassId)?.total ?? '0.0000'),
    })),
    ...([['awards', 'award'], ['safes', 'safe'], ['notes', 'note']] as const).map(([key, kind]) => ({
      key, code: null, data: curve.map((point) => payoutTotal(point.result, kind)),
    })),
  ]
  return { exitValues, series: series.filter((row) => row.data.some((value) => !isZero(value))) }
}
