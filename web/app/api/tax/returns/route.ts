import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { installTaxReturnPack, taxReturnPack } from '@openbooks/engine/src/seed-tax-forms.ts'
import { guardPermission } from '../../../../lib/authz'

export const runtime = 'nodejs'

/** List the org's configured tax-return forms. */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute(sql`
    select code, name, country, submission_channel, government_format, submission_url,
           official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${gate.user.orgId} and is_active
     order by name`)) as unknown as {
    rows: { code: string; name: string; country: string | null; submission_channel: string; government_format: string; submission_url: string | null; has_official: boolean }[]
  }
  return NextResponse.json({ forms: r.rows })
}

/** Install or reset a reference jurisdiction pack from Setup. */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as { pack?: string }
  if (!body.pack || !taxReturnPack(body.pack)) {
    return NextResponse.json({ error: 'unknown pack' }, { status: 422 })
  }
  const result = await installTaxReturnPack(gate.user.orgId, body.pack, gate.user.id)
  return NextResponse.json(result)
}
