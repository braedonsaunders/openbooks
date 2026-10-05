import { NextResponse } from 'next/server'
import { sql, type SQL } from 'drizzle-orm'
import {
  AutopayError,
  parseExpiryNoticeDays,
  parseFinalAction,
  parseRetryOffsetsDays,
} from '@openbooks/engine/payments/autopay'
import { guardPermission } from '../../../lib/authz'
import { isFeatureEnabled } from '@/lib/features'
import { notFound } from '@/lib/api/responses'

/**
 * The autopay retry schedule and final action ride on the dunning policy but
 * move money, so they carry their own duty: a writer changing ONLY the
 * ladder needs no extra authority, but touching either autopay field needs
 * `autopay.manage` with the autopay surface on. Reads stay with the policy.
 */
export async function requireAutopayWrite(
  authz: Exclude<Awaited<ReturnType<typeof guardPermission>>, NextResponse>,
): Promise<NextResponse | null> {
  const gate = await guardPermission('autopay.manage')
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(authz.user.orgId, 'autopay'))) return notFound('record')
  return null
}

/**
 * Normalize the setup form's retry schedule (objectArray rows of {days},
 * tolerated as bare numbers) to the integer list the policy stores. Throws
 * AutopayError naming the fix; the routes translate it to a 422.
 */
export function normalizeRetryOffsets(raw: unknown): number[] {
  const list = Array.isArray(raw) ? raw : []
  const days = list.map((entry) =>
    entry !== null && typeof entry === 'object' && 'days' in (entry as Record<string, unknown>)
      ? (entry as Record<string, unknown>).days
      : entry,
  )
  return parseRetryOffsetsDays(days)
}

export function normalizeFinalAction(raw: unknown): 'none' | 'suspend' | 'cancel' {
  return parseFinalAction(raw)
}

/**
 * Normalize the pre-expiry outreach window (whole days, 1–90). Throws
 * AutopayError naming the fix; the routes translate it to a 422.
 */
export function normalizeExpiryNoticeDays(raw: unknown): number {
  return parseExpiryNoticeDays(raw)
}

/** SQL fragment for the integer[] column from a validated offset list. */
export function retryOffsetsSql(offsets: number[]): SQL {
  return offsets.length > 0
    ? sql`ARRAY[${sql.join(offsets.map((offset) => sql`${offset}`), sql`, `)}]`
    : sql`'{}'::integer[]`
}

export function autopayFieldError(e: unknown): NextResponse | null {
  if (e instanceof AutopayError) return NextResponse.json({ error: e.message }, { status: 422 })
  return null
}
