import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { MODULE_BY_KEY, type OrgNavConfig } from '../../../../lib/nav/registry'

export const runtime = 'nodejs'

function validate(config: unknown): config is OrgNavConfig {
  const c = config as OrgNavConfig
  if (!c || c.version !== 2 || !Array.isArray(c.groups) || c.groups.length === 0 || c.groups.length > 32) return false
  const groupIds = new Set<string>()
  const moduleKeys = new Set<string>()
  const appKeys = new Set<string>()
  let itemCount = 0
  for (const g of c.groups) {
    if (
      typeof g.id !== 'string' ||
      !g.id.trim() ||
      g.id.length > 100 ||
      groupIds.has(g.id) ||
      typeof g.label !== 'string' ||
      !g.label.trim() ||
      g.label.length > 80 ||
      !Array.isArray(g.items)
    )
      return false
    groupIds.add(g.id)
    itemCount += g.items.length
    if (itemCount > 256) return false
    for (const i of g.items) {
      if (i.kind === 'module') {
        if (!MODULE_BY_KEY.has(i.moduleKey) || moduleKeys.has(i.moduleKey)) return false
        moduleKeys.add(i.moduleKey)
      } else if (i.kind === 'app') {
        if (
          typeof i.appKey !== 'string' ||
          !/^[a-z][a-z0-9-]*$/.test(i.appKey) ||
          appKeys.has(i.appKey) ||
          (i.label !== undefined && (typeof i.label !== 'string' || i.label.length > 100))
        )
          return false
        appKeys.add(i.appKey)
      } else if (i.kind === 'link') {
        if (
          typeof i.href !== 'string' ||
          (!i.href.startsWith('/') && !i.href.startsWith('https://')) ||
          typeof i.label !== 'string' ||
          !i.label.trim() ||
          i.label.length > 100
        )
          return false
      } else {
        return false
      }
      if (i.mobile !== undefined && typeof i.mobile !== 'boolean') return false
    }
  }
  const mobileCount = c.groups.flatMap((group) => group.items).filter((item) => item.mobile).length
  if (mobileCount > 4) return false
  return true
}

export async function PUT(req: Request) {
  const gate = await guardPermission('admin.customization.manage')
  if (gate instanceof NextResponse) return gate
  const { user } = gate

  const { config } = (await req.json()) as { config?: unknown }
  if (!validate(config)) return NextResponse.json({ error: 'invalid nav config' }, { status: 400 })

  const configuredAppKeys = config.groups.flatMap((group) =>
    group.items.flatMap((item) => (item.kind === 'app' ? [item.appKey] : [])),
  )
  if (configuredAppKeys.length > 0) {
    const installed = (await db.execute(sql`
      select key from apps where org_id = ${user.orgId} and key = any(${configuredAppKeys}::text[])
    `)) as unknown as { rows: { key: string }[] }
    if (installed.rows.length !== configuredAppKeys.length) {
      return NextResponse.json({ error: 'navigation references an unknown app' }, { status: 400 })
    }
  }

  await db.execute(sql`
    insert into org_nav_configs (org_id, config)
    values (${user.orgId}, ${JSON.stringify(config)})
    on conflict (org_id) do update set config = excluded.config, updated_at = now()
  `)
  return NextResponse.json({ ok: true })
}
