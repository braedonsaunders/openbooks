import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { sealSecret } from "@openbooks/engine/platform/secrets";
import { FORM_TYPES, type FormType } from "@openbooks/engine/compliance/information-returns";
import { guardPermission, guardSubsidiaryScope } from "@/lib/authz";
import { guardInformationReturnsFeature } from "@/lib/compliance";
import { isFeatureEnabled } from "@/lib/features";
import { complianceWriteFailure } from "@/lib/compliance-errors";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.object({
  complianceClassId: uuidString({ error: "complianceClassId must be a valid compliance class id" })
    .nullable()
    .optional(),
  informationReturnForm: z
    .string()
    .refine(
      (value) => value === "none" || FORM_TYPES.includes(value as FormType),
      "informationReturnForm must be an installed information return form or none",
    )
    .nullable()
    .optional(),
  informationReturnBox: z.string().trim().max(40).nullable().optional(),
  taxClassification: z
    .string()
    .refine(
      (value) => TAX_CLASSIFICATIONS.has(value),
      "taxClassification must be an installed tax classification",
    )
    .nullable()
    .optional(),
  tin: z
    .string()
    .max(100)
    .refine(
      (value) => value.trim() === "" || /^\d{9}$/.test(value.replace(/[\s-]/g, "")),
      "tin must contain exactly 9 digits; remove other characters and correct the number",
    )
    .nullable()
    .optional(),
  tinType: z
    .string()
    .refine((value) => TIN_TYPES.has(value), "tinType must be an installed TIN type")
    .nullable()
    .optional(),
  backupWithholding: z
    .boolean({ error: "backupWithholding must be a boolean" })
    .nullable()
    .optional(),
  reportable: z.boolean({ error: "reportable must be a boolean" }).nullable().optional(),
  reason: z
    .string()
    .trim()
    .min(1, "reason is required for a vendor compliance change")
    .max(2000)
    .optional(),
});

async function authorizeVendorSettings() {
  const gate = await guardPermission("compliance.manage");
  if (gate instanceof NextResponse) return gate;
  const [returnsOn, complianceOn] = await Promise.all([
    isFeatureEnabled(gate.user.orgId, "informationReturns"),
    isFeatureEnabled(gate.user.orgId, "subcontractorCompliance"),
  ]);
  if (!returnsOn && !complianceOn) {
    return (await guardInformationReturnsFeature(gate.user.orgId)) ?? gate;
  }
  return gate;
}

export const runtime = "nodejs";

const TAX_CLASSIFICATIONS = new Set([
  "individual",
  "sole_proprietor",
  "partnership",
  "c_corp",
  "s_corp",
  "llc",
  "trust_estate",
  "government",
  "nonprofit",
  "other",
]);
const TIN_TYPES = new Set(["ssn", "ein", "itin", "atin", "sin", "bn", "unknown"]);

/**
 * The compliance mutation's audit envelope is a complete snapshot of every
 * field this route owns, plus row identity/attribution.  `tin_encrypted` is
 * intentionally represented only by presence: ciphertext is sensitive too,
 * while `tin_last4` gives the reviewer enough evidence to identify a change.
 */
const VENDOR_ROLE_AUDIT_COLUMNS = sql`
  id, org_id, party_id, compliance_class_id, information_return_form,
  information_return_box, tax_classification,
  (tin_encrypted is not null) as tin_present, tin_last4, tin_type,
  backup_withholding, is_t4a, is_active, created_at, created_by,
  updated_at, updated_by`;

type VendorRoleAuditRow = Record<string, unknown>;

/** Every compliance save is attributable even when the UI supplies no note. */
function auditReason(raw: unknown): string {
  return typeof raw === "string" && raw.trim()
    ? raw.trim().slice(0, 500)
    : "vendor compliance updated";
}

/**
 * A vendor's compliance classification and taxpayer identification.
 *
 * Kept off the general party route on purpose: the compliance class decides
 * whether this vendor's money can be released, and a TIN is regulated personal
 * data. Both belong behind `compliance.manage`, not behind the permission that
 * lets someone fix a phone number.
 *
 * The TIN is sealed with the org data key before it is stored; only the last
 * four digits are kept in plaintext, and only those are ever read back.
 */
export const PATCH = defineRoute({
  authorize: authorizeVendorSettings,
  feature: {
    none: "Vendor settings span information-return and subcontractor-compliance features; each field is checked against its own switch.",
  },
  params: z.object({ partyId: z.string() }),
  body: requestBodySchema,
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const params = Promise.resolve(routeParams);
    const { orgId, id: actorId } = gate.user;
    // This route serves two switches: the compliance class is COI tracking
    // (subcontractorCompliance) while the taxpayer identity — TIN, filing
    // form/box, withholding — is year-end tax (informationReturns). Each
    // field enforces its own switch below; reaching neither switch at all is
    // indistinguishable from no API.
    const [returnsOn, complianceOn] = await Promise.all([
      isFeatureEnabled(orgId, "informationReturns"),
      isFeatureEnabled(orgId, "subcontractorCompliance"),
    ]);
    const { partyId } = await params;
    if (!isUuid(partyId)) return notFound("record");
    // The vendor is the record boundary: a restricted caller may only touch
    // compliance identity for parties inside their fence (null-subsidiary
    // parties are org-wide, mirroring the party lists and the bank-detail
    // route). Without this, a hidden-entity TIN could be overwritten blind.
    const partyScope = await db.execute<{ subsidiaryId: string | null }>(
      sql`
      select subsidiary_id as "subsidiaryId" from parties
       where id = ${partyId} and org_id = ${orgId}`,
      "objects",
    );
    if (!partyScope[0]) return notFound("record");
    const scopeDenied = guardSubsidiaryScope(gate, partyScope[0].subsidiaryId, {
      orgWideNull: true,
    });
    if (scopeDenied) return scopeDenied;

    // Per-field switches: taxpayer identity needs the tax switch, the
    // tracking class needs the compliance switch. Each names the switch
    // that is actually off, so the operator knows where to turn it on.
    const touchesReturns =
      body.informationReturnForm !== undefined ||
      body.informationReturnBox !== undefined ||
      body.taxClassification !== undefined ||
      body.tin !== undefined ||
      body.tinType !== undefined ||
      body.backupWithholding !== undefined ||
      body.reportable !== undefined;
    if (touchesReturns && !returnsOn) {
      const blocked = await guardInformationReturnsFeature(orgId);
      if (blocked) return blocked;
    }
    if (body.complianceClassId !== undefined && !complianceOn) {
      return NextResponse.json(
        { error: "subcontractor compliance feature is disabled" },
        { status: 404 },
      );
    }

    if (body.complianceClassId && !isUuid(body.complianceClassId)) {
      return NextResponse.json({ error: "invalid compliance class" }, { status: 400 });
    }
    if (
      body.informationReturnForm &&
      body.informationReturnForm !== "none" &&
      !FORM_TYPES.includes(body.informationReturnForm as FormType)
    ) {
      return NextResponse.json({ error: "unknown information return form" }, { status: 400 });
    }
    if (body.taxClassification && !TAX_CLASSIFICATIONS.has(body.taxClassification)) {
      return NextResponse.json({ error: "unknown tax classification" }, { status: 400 });
    }
    if (body.tinType && !TIN_TYPES.has(body.tinType)) {
      return NextResponse.json({ error: "unknown TIN type" }, { status: 400 });
    }
    // Both toggles ride into coalesce() against boolean columns: Postgres would
    // parse 'yes'/'no' but die on anything else, surfacing the full vendor_roles
    // UPDATE through the catch below. Refuse non-booleans with a named 400.
    for (const key of ["backupWithholding", "reportable"] as const) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== "boolean") {
        return NextResponse.json({ error: `${key} must be a boolean` }, { status: 400 });
      }
    }

    // A TIN is digits; separators are cosmetic. Reject anything else rather than
    // storing a half-typed number that will fail at the filing channel in January.
    let tinEncrypted: string | null | undefined;
    let tinLast4: string | null | undefined;
    if (body.tin !== undefined) {
      if (body.tin === null || body.tin.trim() === "") {
        tinEncrypted = null;
        tinLast4 = null;
      } else {
        const digits = body.tin.replace(/[\s-]/g, "");
        if (!/^\d{9}$/.test(digits)) {
          return NextResponse.json(
            { error: "a taxpayer identification number is exactly 9 digits" },
            { status: 400 },
          );
        }
        tinEncrypted = sealSecret(digits, { orgId, purpose: "compliance.vendor.tin" });
        tinLast4 = digits.slice(-4);
      }
    }

    // The class check runs before the write transaction, not inside it: the
    // catch below maps every unclassified failure to a generic 500, so a
    // computed refusal raised in there would never reach the operator.
    if (body.complianceClassId) {
      const exists = await db.execute(
        sql`
        select 1 from compliance_classes
         where org_id = ${orgId} and id = ${body.complianceClassId} and is_active`,
        "objects",
      );
      if (exists.length === 0) {
        return NextResponse.json({ error: "unknown compliance class" }, { status: 400 });
      }
    }

    const reason = auditReason(body.reason);
    let recordMissing = false;
    try {
      await withOrgTransaction(orgId, async () => {
        // Lock the authoritative tenant row before reading its before-state.
        // Every subsequent write and the audit insert participates in this same
        // pinned transaction, so concurrent saves serialize and an audit error
        // rolls the sensitive compliance/TIN mutation back with it.
        const role = await db.execute<VendorRoleAuditRow>(
          sql`
          select ${VENDOR_ROLE_AUDIT_COLUMNS}
            from vendor_roles
           where org_id = ${orgId} and party_id = ${partyId}
           for update`,
          "objects",
        );
        const before = role[0];
        if (!before) {
          recordMissing = true;
          return;
        }

        const updated = await db.execute<VendorRoleAuditRow>(
          sql`
          update vendor_roles set
            compliance_class_id = ${body.complianceClassId === undefined ? sql`compliance_class_id` : sql`${body.complianceClassId}::uuid`},
            information_return_form = ${body.informationReturnForm === undefined ? sql`information_return_form` : sql`${body.informationReturnForm}`},
            information_return_box = ${body.informationReturnBox === undefined ? sql`information_return_box` : sql`${body.informationReturnBox}`},
            tax_classification = ${body.taxClassification === undefined ? sql`tax_classification` : sql`${body.taxClassification}`},
            tin_encrypted = ${tinEncrypted === undefined ? sql`tin_encrypted` : sql`${tinEncrypted}`},
            tin_last4 = ${tinLast4 === undefined ? sql`tin_last4` : sql`${tinLast4}`},
            tin_type = ${body.tinType === undefined ? sql`tin_type` : sql`${body.tinType}`},
            backup_withholding = coalesce(${body.backupWithholding ?? null}, backup_withholding),
            is_t4a = coalesce(${body.reportable ?? null}, is_t4a),
            updated_at = now(), updated_by = ${actorId}
          where org_id = ${orgId} and party_id = ${partyId}
          returning ${VENDOR_ROLE_AUDIT_COLUMNS}`,
          "objects",
        );
        const after = updated[0];
        // The row was locked by this transaction's own read, so a zero-row
        // update means it vanished under the lock — still the vendor-missing
        // refusal, raised through the flag like the pre-lock read.
        if (!after) {
          recordMissing = true;
          return;
        }

        // The audit row is immutable at the database layer. Its actor_id and at
        // columns are written by PostgreSQL, while changes.reason and the exact
        // secret-free before/after snapshots make the evidence attributable and
        // complete without ever persisting TIN ciphertext in the trail.
        await db.execute(sql`
          insert into audit_log(org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'vendor_roles', ${partyId}, 'update',
                  ${JSON.stringify({ reason, before, after })}::jsonb, ${actorId})`);
      });
      if (recordMissing)
        return NextResponse.json({ error: "this party is not a vendor" }, { status: 404 });
      return NextResponse.json({ partyId });
    } catch (e) {
      return complianceWriteFailure(e);
    }
  },
});
