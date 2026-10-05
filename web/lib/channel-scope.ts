import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { notFound } from '@/lib/api/responses'
import { guardSubsidiaryScope, subsidiaryScopeAllows, type Authz } from '@/lib/authz'

/**
 * Legal-entity scope for Sales Channels. A channel posts its orders into the
 * ledger of the subsidiary it is assigned to, so a caller restricted to some
 * entities may read, configure or replay only channels assigned to one of
 * them. A channel with no subsidiary posts at the organization level and is
 * visible only to unrestricted callers. An out-of-scope channel answers
 * exactly like a missing one, so ids cannot be probed.
 */
export async function guardChannelScope(authz: Authz, channelId: string): Promise<NextResponse | null> {
  if (authz.allowedSubsidiaryIds === null) return null
  const row = (await withOrgContext(authz.user.orgId, () => db.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from sales_channels where org_id = ${authz.user.orgId} and id = ${channelId}`))).rows[0]
  if (!row) return notFound('channel')
  return guardSubsidiaryScope(authz, row.subsidiary_id) ? notFound('channel') : null
}

/** A channel order (or its parked exception) is in scope exactly when its channel is. */
export async function guardChannelOrderScope(authz: Authz, orderId: string): Promise<NextResponse | null> {
  if (authz.allowedSubsidiaryIds === null) return null
  const row = (await withOrgContext(authz.user.orgId, () => db.execute<{ subsidiary_id: string | null }>(sql`
    select c.subsidiary_id
      from channel_orders o
      join sales_channels c on c.org_id = o.org_id and c.id = o.channel_id
     where o.org_id = ${authz.user.orgId} and o.id = ${orderId}`))).rows[0]
  if (!row) return notFound('record')
  return guardSubsidiaryScope(authz, row.subsidiary_id) ? notFound('record') : null
}

/**
 * Assigning a channel to an entity routes its orders into that entity's
 * ledger, so a restricted caller may assign only an entity they can see, and
 * may not leave a channel organization-level.
 */
export function channelAssignmentRefusal(authz: Authz, subsidiaryId: string | null | undefined): NextResponse | null {
  if (subsidiaryScopeAllows(authz.allowedSubsidiaryIds, subsidiaryId)) return null
  return NextResponse.json(
    {
      error: 'This channel must be assigned to a subsidiary your role can access.',
      remedy: 'Choose one of your subsidiaries for the channel, or ask an administrator with access to every subsidiary.',
      field: 'subsidiaryId',
    },
    { status: 403 },
  )
}

/**
 * Posting accounts mapped onto a channel: an account owned by a subsidiary the
 * caller cannot see is refused; organization-wide accounts stay available.
 */
export async function channelAccountsRefusal(authz: Authz, accountIds: readonly string[]): Promise<NextResponse | null> {
  if (authz.allowedSubsidiaryIds === null || accountIds.length === 0) return null
  const rows = (await withOrgContext(authz.user.orgId, () => db.execute<{ subsidiary_id: string | null }>(sql`
    select subsidiary_id from accounts
     where org_id = ${authz.user.orgId} and id = any(${`{${accountIds.join(',')}}`}::uuid[])`))).rows
  if (rows.every((row) => subsidiaryScopeAllows(authz.allowedSubsidiaryIds, row.subsidiary_id, { orgWideNull: true }))) return null
  return NextResponse.json(
    {
      error: 'A posting account belongs to a subsidiary your role cannot access.',
      remedy: 'Map an account of the channel\'s own subsidiary or an organization-wide account.',
      field: 'accountId',
    },
    { status: 403 },
  )
}

/** Channels a list or dashboard may show this caller. */
export function channelsInScope<T extends { subsidiaryId: string | null }>(authz: Authz, channels: readonly T[]): T[] {
  return channels.filter((channel) => subsidiaryScopeAllows(authz.allowedSubsidiaryIds, channel.subsidiaryId))
}
