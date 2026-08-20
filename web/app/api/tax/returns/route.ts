import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { installTaxReturnPacks, TAX_RETURN_PACKS } from '@openbooks/engine/src/seed-tax-forms.ts'
import { guardPermission } from '../../../../lib/authz'
import { planTaxReturnLibraryChange } from '../../../../lib/setup/tax-return-library'

export const runtime = 'nodejs'

/** List the org's configured tax-return forms. */
export async function GET() {
  const gate = await guardPermission('reports.read')
  if (gate instanceof NextResponse) return gate
  const r = (await db.execute<{ code: string; name: string; country: string | null; submission_channel: string; government_format: string; submission_url: string | null; has_official: boolean }>(sql`
    select code, name, country, submission_channel, government_format, submission_url,
           official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${gate.user.orgId} and is_active
     order by name`))
  return NextResponse.json({ forms: r.rows })
}

/** Atomically install or explicitly reset one or more reference jurisdiction packs. */
export async function POST(req: Request) {
  const gate = await guardPermission('admin.setup.manage')
  if (gate instanceof NextResponse) return gate
  const body = await req.json().catch(() => null)
  const installedRows = (await db.execute<{ code: string }>(sql`
    select code from tax_return_forms where org_id = ${gate.user.orgId}
  `))
  const plan = planTaxReturnLibraryChange(
    body,
    new Set(TAX_RETURN_PACKS.map((pack) => pack.code)),
    new Set(installedRows.rows.map((row) => row.code)),
  )
  if ('error' in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status })
  }
  const results = plan.targets.length > 0
    ? await installTaxReturnPacks(gate.user.orgId, plan.targets, gate.user.id)
    : []
  return NextResponse.json({
    installed: plan.mode === 'install' ? results.map((result) => result.code) : [],
    reset: plan.mode === 'reset' ? results.map((result) => result.code) : [],
    skipped: plan.skipped,
    results,
  })
}
