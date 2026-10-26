import type { Authz } from "@/lib/authz";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { filterTaxReturnFormsByFeatures } from "@openbooks/engine/tax-returns/return";
import {
  listInstalledTaxReturnFormCodes,
  listTaxReturnForms,
} from "@openbooks/engine/tax-returns/return-queries";
import { installTaxReturnPacks, TAX_RETURN_PACKS } from "@openbooks/engine/tax/seed-tax-forms";
import { planTaxReturnLibraryChange } from "@/lib/setup/tax-return-library";

export const runtime = "nodejs";

const bodyObjectSchema = z
  .object({
    mode: z.enum(["install", "reset"]),
    packs: z.array(z.string().min(1)).min(1).max(25),
  })
  .strict();

/** List the org's configured tax-return forms. */
async function legacyGET(
  request: Request,
  ctx: { params: Promise<unknown> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const r = await listTaxReturnForms(gate.user.orgId);
  return NextResponse.json({ forms: await filterTaxReturnFormsByFeatures(gate.user.orgId, r) });
}

/** Atomically install or explicitly reset one or more reference jurisdiction packs. */
async function legacyPOST(body: z.infer<typeof bodyObjectSchema>, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  const installedRows = await listInstalledTaxReturnFormCodes(gate.user.orgId);
  const plan = planTaxReturnLibraryChange(
    body,
    new Set(TAX_RETURN_PACKS.map((pack) => pack.code)),
    new Set(installedRows.map((row) => row.code)),
  );
  if ("error" in plan) {
    return NextResponse.json({ error: plan.error }, { status: plan.status });
  }
  const results =
    plan.targets.length > 0
      ? await installTaxReturnPacks(gate.user.orgId, plan.targets, gate.user.id)
      : [];
  return NextResponse.json({
    installed: plan.mode === "install" ? results.map((result) => result.code) : [],
    reset: plan.mode === "reset" ? results.map((result) => result.code) : [],
    skipped: plan.skipped,
    results,
  });
}

export const GET = defineRoute({
  permission: "reports.read",
  feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "This route is governed by its permission and service authorization." },
  // Installing or resetting reference jurisdiction packs rewrites the org-wide library.
  scope: "unrestricted",
  body: bodyObjectSchema,
  handler: ({ body, authz }) => legacyPOST(body, authz),
});
