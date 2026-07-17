import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { seedCanadaGst34 } from '@openbooks/engine/src/seed-tax-forms.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** List the org's configured tax-return forms. */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select code, name, country, submission_channel
      from tax_return_forms
     where org_id = ${gate.user.orgId} and is_active
     order by name`)) as unknown as {
    rows: { code: string; name: string; country: string | null; submission_channel: string }[]
  }
  return NextResponse.json({ forms: r.rows })
}

/** Install a reference jurisdiction pack (currently Canada GST34). */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.users.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { pack?: string }
  if (body.pack !== 'CA_GST34') {
    return NextResponse.json({ error: 'unknown pack' }, { status: 422 })
  }
  const result = await seedCanadaGst34(gate.user.orgId, gate.user.id)
  return NextResponse.json(result)
}
