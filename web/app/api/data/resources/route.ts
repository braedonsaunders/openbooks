import { NextResponse } from 'next/server'
import { can, getAuthz } from '../../../../lib/authz'
import { getResource, listResources } from '../../../../lib/data-io/resources'

export const runtime = 'nodejs'

/**
 * GET /api/data/resources          → resources this user can export/import.
 * GET /api/data/resources?key=...  → { descriptor, fields } for one resource.
 * Exporters see descriptors filtered by read permission; callers admitted
 * through data.import alone see the importable subset filtered by write
 * permission, so an import-only role can still reach the import wizard.
 */
export async function GET(req: Request) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const admitsExport = can(authz, 'data.export')
  const admitsImport = can(authz, 'data.import')
  if (!admitsExport && !admitsImport) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const orgId = authz.user.orgId
  const key = new URL(req.url).searchParams.get('key')

  if (key) {
    const resource = await getResource(orgId, key)
    if (!resource) return NextResponse.json({ error: 'unknown resource' }, { status: 404 })
    if (!can(authz, resource.descriptor.readPermission) &&
        !(admitsImport && can(authz, resource.descriptor.writePermission))) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    const [fields, columns] = await Promise.all([resource.fields(), resource.columns()])
    return NextResponse.json({ descriptor: resource.descriptor, fields, columns })
  }

  const all = await listResources(orgId)
  const visible = admitsExport
    ? all.filter((d) => can(authz, d.readPermission))
    : all.filter((d) => d.supportsImport && can(authz, d.writePermission))
  return NextResponse.json({ resources: visible })
}
