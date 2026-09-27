import type { Authz } from "@/lib/authz";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { filterTaxReturnFormsByFeatures } from '@openbooks/engine/src/tax-returns/return.ts'
import { installTaxReturnPacks, TAX_RETURN_PACKS } from '@openbooks/engine/src/tax/seed-tax-forms.ts'
import { guardUnrestrictedScope } from '../../../../lib/authz'
import { planTaxReturnLibraryChange } from '../../../../lib/setup/tax-return-library'

export const runtime = 'nodejs'

const bodyObjectSchema = z.object({
  mode: z.enum(["install", "reset"]),
  packs: z.array(z.string().min(1)).min(1).max(25),
}).strict();

/** List the org's configured tax-return forms. */
async function legacyGET(request: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const r = (await db.execute<{ code: string; name: string; country: string | null; submission_channel: string; government_format: string; submission_url: string | null; notice_key: string | null; has_official: boolean }>(sql`
    select code, name, country, submission_channel, government_format, submission_url,
           notice_key, official_pdf_file_id is not null as has_official
      from tax_return_forms
     where org_id = ${gate.user.orgId} and is_active
     order by name`))
  return NextResponse.json({ forms: await filterTaxReturnFormsByFeatures(gate.user.orgId, r.rows) })
}

/** Atomically install or explicitly reset one or more reference jurisdiction packs. */
async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  // Installing or resetting reference jurisdiction packs rewrites the
  // org-wide return library used by every entity.
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted
  const parsedBody = await parseJsonBody(req, bodyObjectSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
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

export const GET = defineRoute({
  permission: 'reports.read', feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: 'admin.setup.manage', feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
