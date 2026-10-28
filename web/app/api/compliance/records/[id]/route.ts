import { submitCertificateVerification } from "@openbooks/engine/compliance/certificate-verification";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { normalizeMoney, wholeDigits } from "@openbooks/engine/money";
import { can, getAuthz, guardSubsidiaryScope } from "@/lib/authz";
import { guardComplianceFeature } from "@/lib/compliance";
import { complianceWriteFailure } from "@/lib/compliance-errors";
import { isUuid } from "@/lib/list-params";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
import { isIsoCalendarDate } from "@openbooks/engine/platform/business-date/module";
import { notFound } from "@/lib/api/responses";

// Keep numeric text at the JSON boundary; optionalCoverageMoney below owns the
// precise amount and column-width refusal for a well-formed update command.
const requestMoney = z
  .string()
  .nullable()
  .describe("Exact amount as decimal text, or null when unknown.");
const revisionField = z
  .number({ error: "revision is required as a positive certificate revision" })
  .int()
  .safe()
  .min(1, "revision must be a positive certificate revision")
  .describe("Positive certificate revision number copied from the certificate read.");
const updateRecordFields = {
  issuerName: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe("Updated insurance carrier or certificate issuer."),
  policyNumber: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .optional()
    .describe("Updated insurance policy number."),
  effectiveFrom: z
    .string()
    .refine(isIsoCalendarDate, "effectiveFrom must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional()
    .describe("Updated coverage start date in YYYY-MM-DD format."),
  expiresOn: z
    .string()
    .refine(isIsoCalendarDate, "expiresOn must be a real calendar date (YYYY-MM-DD)")
    .nullable()
    .optional()
    .describe("Updated coverage expiry date in YYYY-MM-DD format."),
  coverageAmount: requestMoney.optional().describe("Updated exact per-occurrence coverage amount."),
  aggregateAmount: requestMoney.optional().describe("Updated exact aggregate coverage amount."),
  coverageCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/, "coverageCurrency must be a three-letter ISO currency code")
    .nullable()
    .optional()
    .describe("Updated coverage currency code."),
  additionalInsured: z
    .boolean()
    .nullable()
    .optional()
    .describe("Updated additional-insured evidence."),
  waiverOfSubrogation: z
    .boolean()
    .nullable()
    .optional()
    .describe("Updated waiver-of-subrogation evidence."),
  primaryNoncontributory: z
    .boolean()
    .nullable()
    .optional()
    .describe("Updated primary and noncontributory evidence."),
  notes: z.string().trim().max(2000).nullable().optional().describe("Updated review notes."),
};
export const requestBodySchema = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value) && !("action" in value)
      ? { ...value, action: "update" }
      : value,
  z.discriminatedUnion(
    "action",
    [
      z.strictObject({
        action: z
          .literal("verify")
          .describe("Attest that this revision satisfies the requirement."),
        revision: revisionField,
      }),
      z.strictObject({
        action: z.literal("reject").describe("Reject this revision with a reason."),
        revision: revisionField,
        reason: z
          .string()
          .trim()
          .min(1, "reason is required to reject a certificate")
          .max(2000)
          .describe("Reason the certificate does not satisfy the requirement."),
      }),
      z.strictObject({
        action: z.literal("reopen").describe("Reopen a rejected certificate for review."),
        revision: revisionField,
      }),
      z
        .strictObject({
          action: z.literal("update").describe("Edit certificate details."),
          revision: revisionField,
          ...updateRecordFields,
        })
        .refine(
          (body) =>
            Object.keys(updateRecordFields).some(
              (field) => body[field as keyof typeof body] !== undefined,
            ),
          {
            error: "provide at least one certificate field to update",
          },
        ),
    ],
    { error: "action must be verify, reject, reopen, or update" },
  ),
);

export const runtime = "nodejs";

async function authorizeComplianceSession() {
  const authz = await getAuthz();
  if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const blocked = await guardComplianceFeature(authz.user.orgId);
  return blocked ?? authz;
}

function optionalCoverageMoney(value: unknown): string | null | "invalid" {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 4);
  // coverage_amount/aggregate_amount are numeric(19,4): refuse whole-digit
  // widths the column cannot hold before any write.
  if (exact === null || wholeDigits(exact) > 15) return "invalid";
  return normalizeMoney(exact);
}

type Action = "verify" | "reject" | "reopen" | "update";

/**
 * Act on one certificate.
 *
 * `verify` and `reject` are the attestation duty (`compliance.verify`) and are
 * kept apart from editing the certificate's data (`compliance.manage`) —
 * separation of duties, enforced here rather than assumed from the UI.
 *
 * Nothing is ever deleted. A certificate that should not have been accepted is
 * rejected with a reason, which is what an auditor needs to see.
 */

export async function actOnComplianceEvidence(
  routeParams: { id: string },
  authz: import("@/lib/authz").Authz,
  body: z.infer<typeof requestBodySchema>,
) {
  const params = Promise.resolve(routeParams);
  const { orgId, id: actorId } = authz.user;
  const { id } = await params;
  if (!isUuid(id)) return notFound("record");
  const action: Action = body.action;
  if (!["verify", "reject", "reopen", "update"].includes(action)) {
    return NextResponse.json({ error: "unknown certificate action" }, { status: 400 });
  }
  const needed = action === "update" ? "compliance.manage" : "compliance.verify";
  if (!can(authz, needed)) {
    return NextResponse.json({ error: `missing permission: ${needed}` }, { status: 403 });
  }
  // Mandatory optimistic-concurrency token, mirroring the equipment-unit
  // fence: the caller echoes the revision it read, compared under the row
  // lock inside the write transaction. A save without it never reaches the
  // row, so a stale writer is refused instead of overwriting the winner.
  const expectedRevision = body.revision;

  let rejectionReason = "";
  let coverageAmount: string | null | undefined;
  let aggregateAmount: string | null | undefined;
  try {
    if (body.action === "reject") {
      rejectionReason = (body.reason ?? "").trim();
      if (!rejectionReason) {
        return NextResponse.json({ error: "a rejection needs a reason" }, { status: 400 });
      }
    }

    coverageAmount =
      body.action === "update" && body.coverageAmount !== undefined
        ? optionalCoverageMoney(body.coverageAmount)
        : undefined;
    aggregateAmount =
      body.action === "update" && body.aggregateAmount !== undefined
        ? optionalCoverageMoney(body.aggregateAmount)
        : undefined;
    if (coverageAmount === "invalid") {
      return NextResponse.json(
        {
          error: moneyRefusal(
            "Coverage amount",
            body.action === "update" ? body.coverageAmount : undefined,
          ),
        },
        { status: 422 },
      );
    }
    if (aggregateAmount === "invalid") {
      return NextResponse.json(
        {
          error: moneyRefusal(
            "Aggregate amount",
            body.action === "update" ? body.aggregateAmount : undefined,
          ),
        },
        { status: 422 },
      );
    }
    // The update casts these straight to date: shape alone admits impossible
    // days ('2026-09-31') that Postgres then refuses with a raw driver
    // failure, so require real calendar dates before any write.
    if (
      body.action === "update" &&
      body.effectiveFrom !== undefined &&
      body.effectiveFrom !== null &&
      !isIsoCalendarDate(body.effectiveFrom)
    ) {
      return NextResponse.json(
        { error: "effective date must be a real calendar date (YYYY-MM-DD)" },
        { status: 400 },
      );
    }
    if (
      body.action === "update" &&
      body.expiresOn !== undefined &&
      body.expiresOn !== null &&
      !isIsoCalendarDate(body.expiresOn)
    ) {
      return NextResponse.json(
        { error: "expiry date must be a real calendar date (YYYY-MM-DD)" },
        { status: 400 },
      );
    }

    // The row is locked BEFORE it is read: the revision comparison, the
    // lifecycle checks, the mutation and the audit are one serializable
    // unit, so a racing request sees the winner's committed revision and is
    // refused instead of overwriting it — and the audit's before-image is
    // the row as it stood, not a pre-transaction snapshot.
    if (body.action === "verify")
      return NextResponse.json(
        await submitCertificateVerification({
          orgId,
          actorId,
          id,
          revision: expectedRevision,
        }),
      );
    let savedRevision = expectedRevision;
    const outcome = await db.transaction(async (tx) => {
      const locked = await tx.execute<Record<string, unknown>>(
        sql`
          select id, status, party_id, project_id, requirement_id, supersedes_id, revision, verified_revision,
                 created_by, effective_from, expires_on,
                 coverage_amount, aggregate_amount, coverage_currency, additional_insured,
                 waiver_of_subrogation, primary_noncontributory, issuer_name, policy_number
            from compliance_records where org_id = ${orgId} and id = ${id}
           for update
        `,
        "objects",
      );
      const record = locked[0];
      if (!record) return notFound("record");
      // Subsidiary fence runs before every lifecycle and concurrency check:
      // a hidden record reads as 404 no matter which revision or action the
      // caller names, so the refusal never oracles what it cannot see.
      const fencedParty = (
        await tx.execute<{ subsidiaryId: string | null }>(
          sql`
          select subsidiary_id as "subsidiaryId" from parties where org_id = ${orgId} and id = ${record["party_id"]}
        `,
          "objects",
        )
      )[0];
      if (!fencedParty) return notFound("record");
      const fencedPartyDenied = guardSubsidiaryScope(authz, fencedParty.subsidiaryId, {
        orgWideNull: true,
      });
      if (fencedPartyDenied) return fencedPartyDenied;
      if (record["project_id"] !== null && record["project_id"] !== undefined) {
        const fencedProject = (
          await tx.execute<{ subsidiaryId: string | null }>(
            sql`
            select subsidiary_id as "subsidiaryId" from projects where org_id = ${orgId} and id = ${record["project_id"]}
          `,
            "objects",
          )
        )[0];
        if (!fencedProject) return notFound("record");
        const fencedProjectDenied = guardSubsidiaryScope(authz, fencedProject.subsidiaryId, {
          orgWideNull: true,
        });
        if (fencedProjectDenied) return fencedProjectDenied;
      }
      if (record.status === "superseded") {
        return NextResponse.json(
          {
            error: "a superseded certificate is history and cannot be changed",
          },
          { status: 422 },
        );
      }
      if (Number(record.revision) !== expectedRevision) {
        return NextResponse.json(
          {
            error: "this certificate changed since you loaded it — reload and try again",
          },
          { status: 409 },
        );
      }
      // Every applied change bumps the counter under the lock, and the
      // revision predicate makes the bump atomic: zero rows means a racer
      // committed first, and the loser is refused instead of merged.
      const fenced = async (query: ReturnType<typeof sql>) => {
        const applied = await tx.execute<{ id: string }>(query, "objects");
        if (applied.length === 0) {
          return NextResponse.json(
            {
              error: "this certificate changed since you loaded it — reload and try again",
            },
            { status: 409 },
          );
        }
        return null;
      };
      if (body.action === "reject") {
        const refused = await fenced(sql`
            update compliance_records
               set status = 'rejected', rejected_reason = ${rejectionReason},
                   verified_at = null, verified_by = null, verified_revision = null,
                   revision = revision + 1,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id} and revision = ${expectedRevision}
            returning id`);
        if (refused) return refused;
      } else if (body.action === "reopen") {
        const refused = await fenced(sql`
            update compliance_records
               set status = 'pending_review', rejected_reason = null,
                   verified_at = null, verified_by = null, verified_revision = null,
                   revision = revision + 1,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id} and revision = ${expectedRevision}
            returning id`);
        if (refused) return refused;
      } else {
        // Editing the substance of a VERIFIED certificate voids its verification:
        // the attestation was about the old numbers.
        const refused = await fenced(sql`
            update compliance_records
               set issuer_name = coalesce(${body.issuerName ?? null}, issuer_name),
                   policy_number = coalesce(${body.policyNumber ?? null}, policy_number),
                   effective_from = coalesce(${body.effectiveFrom ?? null}::date, effective_from),
                   expires_on = ${body.expiresOn === undefined ? sql`expires_on` : sql`${body.expiresOn}::date`},
                   coverage_amount = ${coverageAmount === undefined ? sql`coverage_amount` : sql`${coverageAmount}`},
                   aggregate_amount = ${aggregateAmount === undefined ? sql`aggregate_amount` : sql`${aggregateAmount}`},
                   coverage_currency = coalesce(${body.coverageCurrency ?? null}, coverage_currency),
                   additional_insured = coalesce(${body.additionalInsured ?? null}, additional_insured),
                   waiver_of_subrogation = coalesce(${body.waiverOfSubrogation ?? null}, waiver_of_subrogation),
                   primary_noncontributory = coalesce(${body.primaryNoncontributory ?? null}, primary_noncontributory),
                   notes = coalesce(${body.notes ?? null}, notes),
                   status = case when status = 'active' then 'pending_review' else status end,
                   verified_at = null, verified_by = null, verified_revision = null,
                   revision = revision + 1,
                   updated_at = now(), updated_by = ${actorId}
             where org_id = ${orgId} and id = ${id} and revision = ${expectedRevision}
            returning id`);
        if (refused) return refused;
      }
      await tx.execute(sql`
          insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'compliance_records', ${id}, ${action === "update" ? "update" : action},
                  ${JSON.stringify({ before: record, after: body })}::jsonb, ${actorId})`);
      savedRevision = Number(record.revision) + 1;
      return null;
    });
    if (outcome) return outcome;
    return NextResponse.json({ id, revision: savedRevision });
  } catch (e) {
    return complianceWriteFailure(e);
  }
}

export const PATCH = defineRoute({
  authorize: authorizeComplianceSession,
  feature: "subcontractorCompliance",
  params: z.object({ id: z.string() }),
  body: requestBodySchema,
  handler: async ({ params: routeParams, authz, body }) =>
    actOnComplianceEvidence(routeParams, authz, body),
});
