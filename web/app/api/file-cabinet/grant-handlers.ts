import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import {
  isAccessLevel,
  listGrants,
  removeGrant,
  setGrant,
  type ResourceType,
} from '../../../lib/file-cabinet'
import { isUuid } from '../../../lib/list-params'
import { recordFileEvent } from '../../../lib/file-audit'
import type { Authz } from '../../../lib/authz'
import { requireFileAccess, requireFolderAccess } from './lib'

/** Manager on the resource is required to view or edit its sharing. */
async function requireManager(
  authz: Authz,
  resourceType: ResourceType,
  resourceId: string,
): Promise<NextResponse | null> {
  return resourceType === 'folder'
    ? requireFolderAccess(authz, resourceId, 'manager')
    : requireFileAccess(authz, resourceId, 'manager')
}

/** Confirm the principal (user or role) exists inside the caller's org. */
async function principalExists(
  orgId: string,
  principalType: string,
  principalId: string,
): Promise<boolean> {
  const table = principalType === 'user' ? sql`users` : sql`app_roles`
  const r = (await db.execute(sql`
    select 1 from ${table} where id = ${principalId} and org_id = ${orgId} limit 1
  `)) as unknown as { rows: unknown[] }
  return r.rows.length > 0
}

/** GET — list the grants on a resource. */
export async function getGrants(
  authz: Authz,
  resourceType: ResourceType,
  resourceId: string,
): Promise<NextResponse> {
  if (!isUuid(resourceId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await requireManager(authz, resourceType, resourceId)
  if (gate) return gate
  const grants = await listGrants(authz.user.orgId, resourceType, resourceId)
  return NextResponse.json({ grants })
}

/** POST — create/update a grant. Body: { principalType, principalId, access }. */
export async function postGrant(
  authz: Authz,
  resourceType: ResourceType,
  resourceId: string,
  body: unknown,
): Promise<NextResponse> {
  if (!isUuid(resourceId)) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const gate = await requireManager(authz, resourceType, resourceId)
  if (gate) return gate

  const b = (body ?? {}) as Record<string, unknown>
  const principalType = b.principalType
  const principalId = b.principalId
  const access = b.access
  if (principalType !== 'user' && principalType !== 'role') {
    return NextResponse.json({ error: 'principalType must be user or role' }, { status: 400 })
  }
  if (typeof principalId !== 'string' || !isUuid(principalId)) {
    return NextResponse.json({ error: 'valid principalId is required' }, { status: 400 })
  }
  if (!isAccessLevel(access)) {
    return NextResponse.json({ error: 'access must be viewer, editor, or manager' }, { status: 400 })
  }
  if (!(await principalExists(authz.user.orgId, principalType, principalId))) {
    return NextResponse.json({ error: 'principal not found' }, { status: 404 })
  }

  await setGrant({
    orgId: authz.user.orgId,
    resourceType,
    resourceId,
    principalType,
    principalId,
    access,
    actorId: authz.user.id,
  })
  await recordFileEvent({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    table: resourceType === 'folder' ? 'folders' : 'files',
    rowId: resourceId,
    action: 'share',
    changes: { principalType, principalId, access },
  })
  return NextResponse.json({ ok: true }, { status: 201 })
}

/** DELETE — remove a grant by id. */
export async function deleteGrant(
  authz: Authz,
  resourceType: ResourceType,
  resourceId: string,
  grantId: string,
): Promise<NextResponse> {
  if (!isUuid(resourceId) || !isUuid(grantId)) {
    return NextResponse.json({ error: 'not found' }, { status: 404 })
  }
  const gate = await requireManager(authz, resourceType, resourceId)
  if (gate) return gate
  const ok = await removeGrant(authz.user.orgId, grantId)
  if (!ok) return NextResponse.json({ error: 'not found' }, { status: 404 })
  await recordFileEvent({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    table: resourceType === 'folder' ? 'folders' : 'files',
    rowId: resourceId,
    action: 'unshare',
    changes: { grantId },
  })
  return NextResponse.json({ ok: true })
}
