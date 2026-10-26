import { submitComplianceWaiver } from "@openbooks/engine/compliance/waivers";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { businessToday, isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { guardSubsidiaryScope } from "@/lib/authz";
import { complianceWriteFailure } from "@/lib/compliance-errors";
import { loadApplicableRequirement } from "@openbooks/engine/compliance/compliance";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({
  partyId: uuidString({ error: "partyId must be a valid vendor id" }),
  requirementId: uuidString({
    error: "requirementId must be a valid compliance requirement id",
  }),
  projectId: uuidString({ error: "projectId must be a valid project id" }).nullable().optional(),
  reason: z.string().trim().min(10, "reason must contain at least 10 characters").max(2000),
  effectiveFrom: z
    .string()
    .refine(isIsoCalendarDate, "the start date must be a real calendar date (YYYY-MM-DD)")
    .optional(),
  expiresOn: z
    .string()
    .refine(isIsoCalendarDate, "the end date must be a real calendar date (YYYY-MM-DD)"),
});

export const runtime = "nodejs";

/** Longest exception anyone can grant in one go. A year-long "temporary"
 *  exception is a policy change, and belongs in the policy. */
const MAX_WAIVER_DAYS = 120;

/**
 * Request an exception to a compliance requirement for one vendor.
 *
 * The native command routes the bounded exception through the tenant's Flows.
 * Every configured gate must complete before release; zero gates release in
 * the request transaction. Permissions, effective dates, reasons and audit
 * evidence apply to either policy.
 */
export const POST = defineRoute({
  permission: "compliance.waive",
  feature: "subcontractorCompliance",
  body: requestBodySchema,
  handler: async ({ authz: gate, body }) => {
    const { orgId, id: actorId } = gate.user;
    const partyId = body.partyId;
    if (!partyId || !isUuid(partyId))
      return NextResponse.json({ error: "partyId is required" }, { status: 400 });
    const requirementId = body.requirementId;
    if (!requirementId || !isUuid(requirementId)) {
      return NextResponse.json({ error: "requirementId is required" }, { status: 400 });
    }
    const reason = (body.reason ?? "").trim();
    if (reason.length < 10) {
      return NextResponse.json(
        { error: "an exception needs a reason of at least 10 characters" },
        { status: 400 },
      );
    }
    const effectiveFrom = body.effectiveFrom ?? (await businessToday(orgId));
    if (!body.expiresOn)
      return NextResponse.json({ error: "an exception must have an end date" }, { status: 400 });
    // Date.parse normalises non-calendar dates (2026-09-31 becomes October
    // 1st), so the span math below would bless them and the write would die in
    // the date column, leaking the full INSERT through the catch below. Refuse
    // anything that is not a real calendar date before any write is attempted.
    for (const [label, value] of [
      ["start date", effectiveFrom],
      ["end date", body.expiresOn],
    ] as const) {
      if (!isIsoCalendarDate(value)) {
        return NextResponse.json(
          { error: `the ${label} must be a real calendar date (YYYY-MM-DD)` },
          { status: 400 },
        );
      }
    }
    const span = Math.round(
      (Date.parse(`${body.expiresOn}T00:00:00Z`) - Date.parse(`${effectiveFrom}T00:00:00Z`)) /
        86_400_000,
    );
    if (!Number.isFinite(span) || span < 0) {
      return NextResponse.json(
        { error: "the end date must not precede the start date" },
        { status: 400 },
      );
    }
    if (span > MAX_WAIVER_DAYS) {
      return NextResponse.json(
        {
          error: `an exception cannot run longer than ${MAX_WAIVER_DAYS} days — change the policy instead`,
        },
        { status: 422 },
      );
    }

    // The exception must name a requirement that belongs to this org and
    // applies to the vendor's class — the same check the evidence write uses.
    // An exception against an inactive, wrong-class or other-org requirement
    // would never be evaluated and would quietly read as "on file".
    const requirement = await loadApplicableRequirement(orgId, partyId, requirementId);
    if (!requirement) {
      return NextResponse.json(
        {
          error: "that requirement does not apply to this vendor — check its compliance class",
        },
        { status: 422 },
      );
    }

    // Subsidiary fence: no exception for a vendor — or under a project —
    // the caller cannot see. Missing and hidden both read as 404, so the
    // refusal never oracles which ids exist elsewhere.
    const waiverParty = (
      await db.execute<{ subsidiaryId: string | null }>(
        sql`
      select subsidiary_id as "subsidiaryId" from parties where org_id = ${orgId} and id = ${body.partyId}
    `,
        "objects",
      )
    )[0];
    if (!waiverParty) return notFound("record");
    const waiverPartyDenied = guardSubsidiaryScope(gate, waiverParty.subsidiaryId, {
      orgWideNull: true,
    });
    if (waiverPartyDenied) return waiverPartyDenied;
    if (body.projectId !== undefined && body.projectId !== null) {
      const waiverProject = (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`
        select subsidiary_id as "subsidiaryId" from projects where org_id = ${orgId} and id = ${body.projectId}
      `,
          "objects",
        )
      )[0];
      if (!waiverProject) return notFound("record");
      const waiverProjectDenied = guardSubsidiaryScope(gate, waiverProject.subsidiaryId, {
        orgWideNull: true,
      });
      if (waiverProjectDenied) return waiverProjectDenied;
    }

    try {
      const result = await withOrgTransaction(orgId, async () => {
        const tx = db;
        // Preserve the bounded request before canonical Flow submission.
        // Only the native release transition makes it effective.
        const inserted = await tx.execute<{ id: string }>(
          sql`
          insert into compliance_waivers
            (org_id, party_id, requirement_id, project_id, reason, effective_from, expires_on,
             requested_by, approved_by, approved_at, created_by, updated_by)
          values (${orgId}, ${body.partyId}, ${body.requirementId}, ${body.projectId ?? null},
                  ${reason}, ${effectiveFrom}, ${body.expiresOn},
                  ${actorId}, null, null, ${actorId}, ${actorId})
          returning id
        `,
          "objects",
        );
        const newId = inserted[0]!.id;
        await tx.execute(sql`
          insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'compliance_waivers', ${newId}, 'insert',
                  ${JSON.stringify({ after: { ...body, reason, effectiveFrom, status: "pending_approval", requestedBy: actorId } })}::jsonb, ${actorId})`);
        return submitComplianceWaiver({ orgId, actorId, id: newId });
      });
      return NextResponse.json(result);
    } catch (e) {
      return complianceWriteFailure(e);
    }
  },
});
