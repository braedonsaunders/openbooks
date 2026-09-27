import type { Authz } from "@/lib/authz";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from '@/lib/api/error-response'
import { parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { isTaxProvisionSelection, packInstallationStatuses, provisionTaxPacks } from '@openbooks/engine/src/tax/pack-provisioning.ts'
import { guardUnrestrictedScope } from '../../../../lib/authz'

export const runtime = 'nodejs'

const bodyObjectSchema = z.object({ packs: z.array(z.string().min(1)).min(1).max(60) }).strict();

/** Registry read surface: installed pack version, install time, and stored vs
 *  declared checksum for every country pack, with drift reported (never
 *  repaired). Gated on reports.read — like the return-library GET — so an
 *  auditor without setup-manage rights can still answer what is installed. */
async function legacyGET(request: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const packs = await packInstallationStatuses(gate.user.orgId)
  return NextResponse.json({ packs })
}

/** Provision the full indirect-tax stack (jurisdiction, code + rate, return form,
 *  nexus) for the selected country/state packs. */
async function legacyPOST(req: Request, ctx: { params: Promise<unknown> }, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  // Provisioning installs org-wide statutory packs used by every entity.
  const unrestricted = guardUnrestrictedScope(gate)
  if (unrestricted) return unrestricted

  const parsedBody = await parseJsonBody(req, bodyObjectSchema);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data
  if (body.packs.some((c) => !isTaxProvisionSelection(c))) {
    return NextResponse.json({ error: 'unknown tax setup selection' }, { status: 422 })
  }

  try {
    const result = await provisionTaxPacks(gate.user.orgId, body.packs, gate.user.id)
    return NextResponse.json(result)
  } catch (e: unknown) {
    return apiErrorResponse(e, { safeStatus: 422 })
  }
}

export const GET = defineRoute({
  permission: 'reports.read', feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: 'admin.setup.manage', feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) => legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
