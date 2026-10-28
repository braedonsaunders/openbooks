import "server-only";
import { NextResponse } from "next/server";
import { can, type Authz } from "@/lib/authz";
import { postPermission } from "../document-kinds";
import { postDocument } from "@openbooks/engine/ledger/posting-document";
import { paymentControlDeps } from "@openbooks/engine/payments/payment-accounts";
import {
  postBatch,
  setBatchLines,
  submitBatch,
  withdrawBatch,
} from "@openbooks/engine/hrm/field-time/crew";
import { getBatchDetail } from "@openbooks/engine/hrm/field-time/reads";
import { FieldTimeError } from "@openbooks/engine/hrm/field-time/errors";

type CrewLine = {
  employeePartyId: string;
  hours: string;
  timeTypeId?: string | null;
  projectTaskId?: string | null;
  costCodeRef?: string | null;
  equipmentId?: string | null;
  equipmentHours?: string | null;
  memo?: string | null;
};

export type CrewBatchAction =
  | { action: "lines"; lines: CrewLine[] }
  | { action: "submit"; signerName?: string | null }
  | { action: "withdraw"; reason?: string | null }
  | { action: "post" };

function bad(error: string, status = 422) {
  return NextResponse.json({ error }, { status });
}

function fieldTime(error: unknown) {
  if (error instanceof FieldTimeError) return bad(error.message);
  throw error;
}

/** Shared write path for the session route and application command catalog. */
export async function handleCrewBatchAction(input: {
  authz: Authz;
  batchId: string;
  body: CrewBatchAction;
}): Promise<Response> {
  const { authz, batchId, body } = input;
  try {
    if (body.action === "lines") {
      const actor = {
        actorUserId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      };
      await setBatchLines({
        orgId: authz.user.orgId,
        actorUserId: authz.user.id,
        batchId,
        lines: body.lines,
        canManageAll: can(authz, "time.manage"),
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json(await getBatchDetail(authz.user.orgId, actor, batchId));
    }
    if (body.action === "submit") {
      const actor = {
        actorUserId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      };
      await submitBatch({
        orgId: authz.user.orgId,
        actorUserId: authz.user.id,
        batchId,
        signerName: body.signerName ?? null,
        canManageAll: can(authz, "time.manage"),
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json(await getBatchDetail(authz.user.orgId, actor, batchId));
    }
    if (body.action === "withdraw") {
      const actor = {
        actorUserId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      };
      await withdrawBatch({
        orgId: authz.user.orgId,
        actorUserId: authz.user.id,
        batchId,
        reason: body.reason ?? null,
        canManageAll: can(authz, "time.manage"),
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json(await getBatchDetail(authz.user.orgId, actor, batchId));
    }

    const batchPostPerm = postPermission("project_charge");
    if (!can(authz, "time.manage"))
      return NextResponse.json({ error: "missing permission: time.manage" }, { status: 403 });
    if (!can(authz, batchPostPerm))
      return NextResponse.json({ error: `missing permission: ${batchPostPerm}` }, { status: 403 });
    const result = await postBatch({
      orgId: authz.user.orgId,
      actorUserId: authz.user.id,
      batchId,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
    });
    const ledgerEntryIds: string[] = [];
    for (const documentId of result.chargeDocumentIds) {
      try {
        ledgerEntryIds.push(
          await postDocument(documentId, await paymentControlDeps(authz.user.orgId)),
        );
      } catch (error) {
        return bad(
          `The batch posted but equipment charge ${documentId} did not reach the ledger (${error instanceof Error ? error.message : "posting failed"}) — re-post the charge document from Equipment`,
        );
      }
    }
    return NextResponse.json({ ...result, ledgerEntryIds });
  } catch (error) {
    return fieldTime(error);
  }
}
