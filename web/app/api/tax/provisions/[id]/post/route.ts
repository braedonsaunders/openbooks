import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  IncomeTaxProvisionError,
  postProvisionRun,
} from "@openbooks/engine/tax-returns/income-tax-provision";
import { incomeTaxProvisionRunExists } from "@openbooks/engine/tax-returns/income-tax-provision-queries";
import { guardUnrestrictedScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";

/** A provision posts and reverses the complete organization-wide entity set.
 * Root-entity access alone cannot authorize journals in its siblings/children. */
async function legacyPOST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;

  const { id } = await params;
  if (!isUuid(id)) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  // Org-wide write (canonical shape 2 in
  // engine/src/organization/subsidiary-scope.ts): posting a provision
  // creates and reverses journals for the complete entity set, so a
  // subsidiary-restricted caller gets the named 403 before any existence
  // lookup — an existing run and a missing id answer identically.
  const scope = guardUnrestrictedScope(gate);
  if (scope) return scope;
  if (!(await incomeTaxProvisionRunExists(gate.user.orgId, id))) return notFound("record");
  try {
    const result = await postProvisionRun(gate.user.orgId, id, gate.user.id);
    return NextResponse.json(result);
  } catch (e) {
    return apiErrorResponse(e, e instanceof IncomeTaxProvisionError ? { safeStatus: 422 } : {});
  }
}

export const POST = defineRoute({
  permission: "gl.post",
  feature: { none: "This route is governed by its permission and service authorization." },
  params: z.object({ id: z.string() }),
  handler: ({ request, params, authz }) =>
    legacyPOST(request, { params: Promise.resolve(params) }, authz),
});
