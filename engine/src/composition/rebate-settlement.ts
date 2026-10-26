import { createPermission } from "../records/document-kind-permissions.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { randomUUID } from "node:crypto";

import { db, withOrg } from "../platform/db.ts";
import { createDocument } from "../ledger/document-write.ts";
import {
  rebateClaimContext,
  recordRebateSettlementDocument,
  rebateSettlementKind,
  RebateError,
} from "../revenue/rebates.ts";
import { cmp, neg } from "../money/money.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { runRecordFlows } from "../flows/index.ts";

export async function createRebateSettlement(
  orgId: string,
  actorId: string,
  claimId: string,
  documentDate: string,
) {
  if (!isIsoCalendarDate(documentDate)) throw new RebateError("Enter the settlement document date");
  const result = await withOrg(orgId, async () => {
    const { claim, agreement: a } = await rebateClaimContext(db, orgId, actorId, claimId);
    const kind = rebateSettlementKind(a.side, claim.amount);
    await lockActorCommandAuthority(db, orgId, actorId, a.subsidiary_id, createPermission(kind));
    if (claim.settlement_document_id)
      return { id: claim.settlement_document_id, kind, created: null };
    if (claim.status !== "approved")
      throw new RebateError("Approve the claim before preparing its settlement");
    if (a.tax_treatment === "taxable" && !a.settlement_tax_code_id)
      throw new RebateError(
        "Set the settlement tax code on the taxable rebate agreement, then prepare a new settlement document",
      );
    const amount = cmp(claim.amount, "0") < 0 ? neg(claim.amount) : claim.amount;
    const body = {
      partyId: claim.party_id,
      documentDate,
      currency: a.currency,
      memo: `Rebate ${a.code} claim settlement`,
      custom: { rebateClaimId: claimId },
      lines: [
        {
          accountId: a.accrual_account_id,
          description: `Rebate ${a.code}`,
          amount,
          quantity: "1",
          unitPrice: amount,
          taxCodeId: a.tax_treatment === "taxable" ? a.settlement_tax_code_id : null,
        },
      ],
    };
    const created = await createDocument({
      orgId,
      userId: actorId,
      kind,
      key: randomUUID(),
      body,
      requestBody: body,
      subsidiaryId: a.subsidiary_id,
    });
    await recordRebateSettlementDocument(orgId, actorId, claimId, created.id);
    return { id: created.id, kind, created };
  });
  if (result.created?.status === "created") {
    await runRecordFlows({ kind: "on_create", source: "api" }, result.kind, result.id, {
      orgId,
      userId: actorId,
    });
    if (result.created.deferredUpdate)
      await runRecordFlows(result.created.deferredUpdate, result.kind, result.id, {
        orgId,
        userId: actorId,
      });
  }
  return { documentId: result.id, kind: result.kind };
}
