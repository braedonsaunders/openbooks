import type { Authz } from "@/lib/authz";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { computeTaxReturn } from "@openbooks/engine/tax-returns/return";
import {
  aggregateTaxReturnAdjustments,
  normalizeTaxReturnAdjustments,
  prepareTaxFiling,
  TAX_RETURN_ADJUSTMENT_LIMIT,
  TAX_RETURN_ADJUSTMENT_REASON_MAX,
} from "@openbooks/engine/tax-returns/filing";
import { loadOrgFilingCalendar } from "@openbooks/engine/tax/nexus-ledger";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { guardSubsidiaryScope, guardUnrestrictedScope } from "@/lib/authz";
import { parseReturnScopeBody, returnScopeOpts } from "@/lib/tax-return-scope";
import { TAX_FILING_WRITE_PERMISSION } from "@/lib/tax-filing-permission";

export const runtime = "nodejs";

const bodyObjectSchema = z
  .object({
    code: z.string().min(1),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    adjustments: z
      .array(
        z
          .object({
            lineCode: z.string().min(1).max(20),
            amount: z.string().max(100),
            reason: z.string().max(10 * TAX_RETURN_ADJUSTMENT_REASON_MAX),
          })
          .strict(),
      )
      .max(TAX_RETURN_ADJUSTMENT_LIMIT)
      .optional(),
    filingEntity: z
      .object({
        subsidiaryIds: z.array(z.string()).optional(),
        registrationId: z.string().optional(),
      })
      .strict()
      .optional(),
    translation: z
      .object({
        presentationCurrency: z.string().optional(),
        rateType: z.string().optional(),
        rateDate: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/**
 * Saving a snapshot (POST here) and marking it filed (PATCH [id]) both
 * certify a statutory position. The tax page derives its Save snapshot and
 * mark-filed affordances from this same symbol — never a second literal —
 * so a grant that can file always sees the action and one that cannot never
 * does.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

/** Filing obligations for the org's registrations in a date range. */
async function legacyGET(
  req: Request,
  ctx: { params: Promise<unknown> },
  injectedGate?: Authz | null,
) {
  const gate = injectedGate as Authz;
  const scopeDenied = guardSubsidiaryScope(gate, null);
  if (scopeDenied) return scopeDenied;
  const p = new URL(req.url).searchParams;
  const today = await businessToday(gate.user.orgId);
  // A supplied date must be a REAL calendar date, not merely YYYY-MM-DD
  // shaped: the calendar builder normalizes 2026-02-30 to March and would
  // answer 200 with empty obligations instead of a named refusal. Absent
  // params still fall back to the defaults.
  for (const name of ["from", "to"] as const) {
    const value = p.get(name);
    if (value !== null && !isIsoDate(value)) {
      return NextResponse.json(
        { error: `invalid ${name} date "${value}" (expected a real YYYY-MM-DD calendar date)` },
        { status: 422 },
      );
    }
  }
  const from = p.get("from") ?? `${today.slice(0, 4)}-01-01`;
  const to = p.get("to") ?? today;
  if (from > to) return NextResponse.json({ error: "invalid period" }, { status: 422 });
  const obligations = await loadOrgFilingCalendar(gate.user.orgId, from, to);
  return NextResponse.json({ from, to, obligations });
}

/**
 * Recompute server-side and freeze a versioned return snapshot in history.
 * Each adjustment entry is recorded with its reason, the preparing user and the
 * time; the engine validates the entries and writes the filing and its audit.
 */
async function legacyPOST(body: z.infer<typeof bodyObjectSchema>, injectedGate?: Authz | null) {
  const gate = injectedGate as Authz;
  if (!body.code || !body.from || !body.to || !isIsoDate(body.from) || !isIsoDate(body.to)) {
    return NextResponse.json({ error: "invalid return or period" }, { status: 422 });
  }
  if (body.from > body.to) return NextResponse.json({ error: "invalid period" }, { status: 422 });
  // The filing scope parses with the SAME shared parser the preview GET
  // uses, so a scoped preview can always be frozen as prepared. An
  // explicitly scoped prepare stays inside the caller's allowed
  // subsidiaries; freezing the org-wide return is an org-wide write
  // (canonical shape 2), so restricted callers get the named 403.
  const parsedScope = parseReturnScopeBody({
    filingEntity: body.filingEntity,
    translation: body.translation,
  });
  if (parsedScope.error || !parsedScope.scope) {
    return NextResponse.json({ error: parsedScope.error ?? "invalid scope" }, { status: 422 });
  }
  if (parsedScope.scope.subsidiaryIds.length > 0) {
    for (const id of parsedScope.scope.subsidiaryIds) {
      const denied = guardSubsidiaryScope(gate, id);
      if (denied) return denied;
    }
  } else {
    const scopeDenied = guardUnrestrictedScope(gate);
    if (scopeDenied) return scopeDenied;
  }

  try {
    const entries = normalizeTaxReturnAdjustments(body.adjustments ?? []);
    const result = await computeTaxReturn(
      gate.user.orgId,
      body.code,
      body.from,
      body.to,
      aggregateTaxReturnAdjustments(entries),
      returnScopeOpts(parsedScope.scope),
    );
    const filing = await prepareTaxFiling(gate.user.orgId, gate.user.id, result, entries);
    // The creation response exposes the persisted filing window, not the requested range.
    return NextResponse.json(
      { ...filing, formCode: result.formCode, from: result.from, to: result.to },
      { status: 201 },
    );
  } catch (error) {
    return apiErrorResponse(error, { safeStatus: 422 });
  }
}

export const GET = defineRoute({
  permission: "reports.read",
  feature: { none: "This route is governed by its permission and service authorization." },

  handler: ({ request, params, authz }) =>
    legacyGET(request, { params: Promise.resolve(params) }, authz),
});

export const POST = defineRoute({
  permission: TAX_FILING_WRITE_PERMISSION,
  feature: { none: "This route is governed by its permission and service authorization." },
  body: bodyObjectSchema,
  invalidBodyStatus: 400,
  handler: ({ body, authz }) => legacyPOST(body, authz),
});
