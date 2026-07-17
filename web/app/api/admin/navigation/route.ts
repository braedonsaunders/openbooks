import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { currentUser } from '../../../../lib/auth'
import { MODULE_BY_KEY, type OrgNavConfig } from '../../../../lib/nav/registry'

export const runtime = 'nodejs'

function validate(config: unknown): config is OrgNavConfig {
  const c = config as OrgNavConfig
  if (!c || c.version !== 2 || !Array.isArray(c.groups) || c.groups.length === 0 || c.groups.length > 32) return false
  const groupIds = new Set<string>()
  const moduleKeys = new Set<string>()
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
  const user = await currentUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (user.role !== 'admin') return NextResponse.json({ error: 'admin only' }, { status: 403 })

  const { config } = (await req.json()) as { config?: unknown }
  if (!validate(config)) return NextResponse.json({ error: 'invalid nav config' }, { status: 400 })

  await db.execute(sql`
    insert into org_nav_configs (org_id, config)
    values (${user.orgId}, ${JSON.stringify(config)})
    on conflict (org_id) do update set config = excluded.config, updated_at = now()
  `)
  return NextResponse.json({ ok: true })
}
