import type { Authz } from "@/lib/authz";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { NATIVE_MEASURES } from "@openbooks/engine/allocations/driver-admin";
import { listAllocationOptions } from "@openbooks/engine/allocations/options-read";

export const runtime = "nodejs";

/**
 * One picker payload for the Drivers + Runs tabs (A8): postable accounts,
 * active dimension values, recent periods, posting books, period-mode rules,
 * report definitions, approval flows for the allocation_run subject (A14),
 * parties (with canonical roles), items, and custom
 * segment values. `allocations.read`. The Rules tab (A7) owns the rule
 * definitions; this only lists them for run filters and previews. Parties
 * and segment values follow the same subsidiary scope as the other
 * subsidiary-aware kinds (null-subsidiary rows are org-wide; an empty scope
 * discloses none); items are organization-wide.
 */
async function legacyGET(
  request: Request,
  ctx: { params: Promise<unknown> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;

  const locale = await getLocale();
  const options = await listAllocationOptions({
    orgId: gate.user.orgId,
    locale,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
  });
  return NextResponse.json({
    ...options,
    measures: NATIVE_MEASURES.map((measure) => ({ id: measure, label: measure })),
  });
}

export const GET = defineRoute({
  permission: "allocations.read",
  feature: "allocations",

  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});
