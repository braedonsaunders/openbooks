import { uuidId } from "@/lib/api/json-schema";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";
import { apiErrorResponse } from "@/lib/api/error-response";
import { guardFeaturePermission } from "@/lib/feature-gates";
import { NextResponse } from "next/server";
import { payrollRunDocumentScope } from "@openbooks/engine/payroll/run-document-reads";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payRunBankFilePopulation,
  payrollBankProfiles,
} from "@openbooks/engine/payroll/bank-file";
import {
  generatePayRunBankFile,
  listPayRunBankFiles,
  payRunBankFileAudit,
  payRunBankFileEntitlement,
} from "@openbooks/engine/payroll/bank-file-artifact";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { SandboxEgressError } from "@openbooks/engine/organization/sandbox-guard";
import { guardSubsidiaryScope } from "../../../../../../lib/authz";
import { isUuid } from "../../../../../../lib/list-params";
import { notFound } from "@/lib/api/responses";

const requestBodySchema = z.strictObject({
  paymentBankProfileId: uuidId,
  supersedeReason: z.string().trim().max(500).nullable().optional(),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The run's direct-deposit panel.
 *
 * GET is the state the operator needs BEFORE they press anything: whether the
 * run is entitled to a file and, if not, the one reason why; which originator
 * profiles are configured; who is on the EFT rail and who is deliberately not;
 * and every artifact ever produced for this run with its release history.
 * Metadata only — never bytes.
 *
 * POST generates a new immutable artifact. The bytes come from the sibling
 * `[fileId]` route, which is where the release is audited; splitting them
 * means a generate can never be mistaken for a release.
 */
export const GET = defineRoute({
  permission: "payroll.read",
  feature: "payroll",
  params: z.object({ id: z.string() }),
  handler: async ({ request: _req, authz: gate, params: routeParams }) => {
    const params = Promise.resolve(routeParams);
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const orgId = gate.user.orgId;

    // The entitlement service intentionally has no caller concept. Resolve the
    // run's legal entity here, before it can disclose entitlement/refusal
    // details or enumerate artifacts, and fail closed exactly like a missing
    // run for a restricted subsidiary.
    const owned = await payrollRunDocumentScope(orgId, id);
    if (!owned) return notFound("record");
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
    if (denied) return denied;

    const entitlement = await payRunBankFileEntitlement(orgId, id, gate.allowedSubsidiaryIds);
    if (entitlement.refusal?.code === "notFound") {
      return notFound("record");
    }

    const [profiles, artifacts, audit] = await Promise.all([
      payrollBankProfiles(orgId),
      listPayRunBankFiles(orgId, id, gate.allowedSubsidiaryIds),
      payRunBankFileAudit(orgId, id, undefined, gate.allowedSubsidiaryIds),
    ]);
    // The population is only meaningful once the run's figures are final.
    const population =
      entitlement.runStatus === "committed" ? await payRunBankFilePopulation(orgId, id) : null;

    return NextResponse.json(
      {
        entitlement,
        population,
        profiles,
        artifacts,
        audit,
        formats: Object.fromEntries(
          Object.entries(PAYROLL_BANK_FILE_FORMATS).map(([key, spec]) => [
            key,
            {
              enabled: spec.enabled,
              currency: spec.currency,
              disabledReason: spec.disabledReason ?? null,
            },
          ]),
        ),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  },
});

/**
 * Generate a new bank-file artifact. `payroll.run`, not `payroll.read`: this
 * produces an instruction to move money, exactly like printing cheques.
 */
export const POST = defineRoute({
  authorize: async ({ params }) => {
    const gate = await guardFeaturePermission("payroll.run", "payroll");
    if (gate instanceof NextResponse) return gate;
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !isUuid(id)) return notFound("record");
    const owned = await payrollRunDocumentScope(gate.user.orgId, id);
    if (!owned) return notFound("record");
    const denied = guardSubsidiaryScope(gate, owned.subsidiaryId);
    return denied ?? gate;
  },
  feature: "payroll",
  body: requestBodySchema,
  params: z.object({ id: z.string() }),
  invalidParamsNotFound: "record",
  handler: async ({ authz: gate, params: routeParams, body }) => {
    const { id } = routeParams;

    try {
      const artifact = await generatePayRunBankFile({
        orgId: gate.user.orgId,
        documentId: id,
        actorId: gate.user.id,
        paymentBankProfileId: body.paymentBankProfileId,
        supersedeReason: body.supersedeReason?.trim() || null,
        allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
      });
      return NextResponse.json({ artifact }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (error instanceof PayrollError || error instanceof SandboxEgressError) {
        const refusal = await apiErrorResponse(error, { safeStatus: 409 });
        refusal.headers.set("Cache-Control", "no-store");
        return refusal;
      }
      throw error;
    }
  },
});
