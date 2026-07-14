import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { currentUser } from '../../../../lib/auth'
import { MODULE_BY_KEY, type OrgNavConfig } from '../../../../lib/nav/registry'

export const runtime = 'nodejs'

function validate(config: unknown): config is OrgNavConfig {
  const c = config as OrgNavConfig
  if (!c || c.version !== 1 || !Array.isArray(c.groups)) return false
  for (const g of c.groups) {
    if (typeof g.label !== 'string' || !Array.isArray(g.items)) return false
    for (const i of g.items) {
      if (i.kind === 'module' && !MODULE_BY_KEY.has(i.moduleKey)) return false
      if (i.kind === 'link' && (typeof i.href !== 'string' || typeof i.label !== 'string')) return false
    }
  }
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
