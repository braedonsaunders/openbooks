import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { guardUnrestrictedScope } from "@/lib/authz";
import { loadCashflowCategories } from "@openbooks/engine/reports/cashflow-categories";
import {
  cashflowCategoryBodySchema,
  replaceCashflowCategories,
} from "@/lib/analytics/cashflow-category-write";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "reports.read",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  handler: async ({ authz: gate }) => {
    const scopeDenied = guardUnrestrictedScope(gate);
    if (scopeDenied) return scopeDenied;
    const snapshot = await loadCashflowCategories(gate.user.orgId);
    return NextResponse.json({
      categories: snapshot.categories,
      revision: snapshot.revision,
    });
  },
});

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: { none: "No optional feature applies to this permission-governed endpoint." },
  scope: "unrestricted",
  body: cashflowCategoryBodySchema,
  handler: async ({ authz: gate, body }) => {
    const result = await replaceCashflowCategories({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      categories: body.categories,
      expectedRevision: body.expectedRevision,
    });
    if (result.kind === "invalid_body")
      return NextResponse.json({ error: result.message }, { status: 400 });
    if (result.kind === "revision_required") {
      return NextResponse.json(
        {
          error: "expectedRevision required",
          message: "Send the revision returned by GET with every replacement.",
        },
        { status: 400 },
      );
    }
    if (result.kind === "invalid_category") {
      return NextResponse.json(
        { error: `invalid category at index ${result.index}`, message: result.message },
        { status: result.status },
      );
    }
    if (result.kind === "missing")
      return NextResponse.json({ error: "org not found" }, { status: 404 });
    if (result.kind === "conflict") {
      return NextResponse.json(
        {
          error: "revision conflict",
          message: `Cashflow categories changed since revision ${body.expectedRevision} (now at ${result.revision}): reload and reapply your edit.`,
          revision: result.revision,
        },
        { status: 409 },
      );
    }
    if (result.kind === "unwritten")
      return NextResponse.json(
        { error: "Cashflow categories were not saved; reload and retry." },
        { status: 409 },
      );
    return NextResponse.json({
      ok: true,
      categories: result.categories,
      revision: result.revision,
    });
  },
});
