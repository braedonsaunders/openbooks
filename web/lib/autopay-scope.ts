import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { notFound } from '@/lib/api/responses'
import { subsidiaryScopeAllows, type Authz } from '@/lib/authz'

/**
 * Stored payment methods, enrollments and collection attempts belong to a
 * customer, and a customer assigned to a subsidiary is visible only to callers
 * who can see that subsidiary (organization-wide customers stay shared, as on
 * every party picker). An out-of-scope customer answers exactly like a missing
 * one, so card brand, last four and expiry never leak across entities.
 */
async function partyScopeDenied(authz: Authz, partySql: ReturnType<typeof sql>): Promise<NextResponse | null> {
  if (authz.allowedSubsidiaryIds === null) return null
  const row = (await withOrgContext(authz.user.orgId, () => db.execute<{ subsidiary_id: string | null }>(partySql))).rows[0]
  if (!row || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, row.subsidiary_id, { orgWideNull: true })) {
    return notFound('record')
  }
  return null
}

export function guardAutopayPartyScope(authz: Authz, partyId: string): Promise<NextResponse | null> {
  return partyScopeDenied(authz, sql`
    select subsidiary_id from parties where org_id = ${authz.user.orgId} and id = ${partyId}`)
}

export function guardPaymentMethodScope(authz: Authz, methodId: string): Promise<NextResponse | null> {
  return partyScopeDenied(authz, sql`
    select p.subsidiary_id from customer_payment_methods m
      join parties p on p.org_id = m.org_id and p.id = m.party_id
     where m.org_id = ${authz.user.orgId} and m.id = ${methodId}`)
}

export function guardEnrollmentScope(authz: Authz, enrollmentId: string): Promise<NextResponse | null> {
  return partyScopeDenied(authz, sql`
    select p.subsidiary_id from autopay_enrollments e
      join parties p on p.org_id = e.org_id and p.id = e.party_id
     where e.org_id = ${authz.user.orgId} and e.id = ${enrollmentId}`)
}

export function guardCollectionAttemptScope(authz: Authz, attemptId: string): Promise<NextResponse | null> {
  return partyScopeDenied(authz, sql`
    select p.subsidiary_id from collection_attempts a
      join autopay_enrollments e on e.org_id = a.org_id and e.id = a.enrollment_id
      join parties p on p.org_id = e.org_id and p.id = e.party_id
     where a.org_id = ${authz.user.orgId} and a.id = ${attemptId}`)
}
