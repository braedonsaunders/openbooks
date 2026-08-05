import { NextResponse } from 'next/server'
import { can, guardPermission } from '../../../../lib/authz'
import { getResource, listResources } from '../../../../lib/data-io/resources'

export const runtime = 'nodejs'

/**
 * GET /api/data/resources          → resources this user can export/import.
 * GET /api/data/resources?key=...  → { descriptor, fields } for one resource.
 * Each descriptor is filtered by the caller's read permission.
 */
export async function GET(req: Request) {
  const gate = await guardPermission('data.export')
  if (gate instanceof NextResponse) return gate
  const authz = gate
  const orgId = authz.user.orgId
  const key = new URL(req.url).searchParams.get('key')

  if (key) {
    const resource = await getResource(orgId, key)
    if (!resource) return NextResponse.json({ error: 'unknown resource' }, { status: 404 })
    if (!can(authz, resource.descriptor.readPermission)) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const [fields, columns] = await Promise.all([resource.fields(), resource.columns()])
    return NextResponse.json({ descriptor: resource.descriptor, fields, columns })
  }

  const all = await listResources(orgId)
  const visible = all.filter((d) => can(authz, d.readPermission))
  return NextResponse.json({ resources: visible })
}
