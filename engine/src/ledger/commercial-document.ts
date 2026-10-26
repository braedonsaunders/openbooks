import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import type { CommercialDocumentKind } from "../records/commercial-document-kind.ts";
import { documentKindPermissions } from "../records/document-kind-permissions.ts";
import { documentRevisionCounterSql } from "../records/revision.ts";
import {
  createDocumentDraft,
  applyDocumentEdit,
  DocumentDraftError,
  type DocumentCreateResult,
} from "./document-write.ts";
import type { DocumentEditInput, DocumentEditCurrent } from "./document-input.ts";

/** Internal commercial writer: numbering, scoped draft creation, native shared
 * editor validation/tax/defaults, transaction audit and deferred record flows.
 * The owning agreement supplies its exactly-once aggregate lock and provenance. */
export async function createCommercialDocument(input: {
  orgId: string;
  actorId: string;
  kind: CommercialDocumentKind;
  subsidiaryId: string;
  body: DocumentEditInput;
}): Promise<DocumentCreateResult> {
  return withOrg(input.orgId, async () => {
    await lockLedgerSetupFence(db, input.orgId, "shared");
    const permission = documentKindPermissions(input.kind)?.edit;
    if (!permission)
      throw new DocumentDraftError("Commercial document kind has no native editing authority");
    const allowed = await lockActorCommandAuthority(
      db,
      input.orgId,
      input.actorId,
      input.subsidiaryId,
      permission,
    );
    if (!(await lockAndCheckOrgFeature(db, input.orgId, "orders")))
      throw new DocumentDraftError(
        "Enable Orders in Company Settings → Features before generating a commercial renewal",
      );
    const draft = await createDocumentDraft(input.orgId, input.actorId, input.kind, {
      allowedSubsidiaryIds: allowed,
      subsidiaryId: input.subsidiaryId,
      runFlows: false,
      source: "api",
      commercialKind: input.kind,
    });
    const current = (
      await db.execute<DocumentEditCurrent>(
        sql`select kind,status,total::text,tax_total::text as "taxTotal",party_id as "partyId",document_date::text as "documentDate",
    ${documentRevisionCounterSql(sql`revision_seq`)} as "updatedAt",custom,subsidiary_id as "subsidiaryId" from documents where org_id=${input.orgId} and id=${draft.id} for update`,
        "objects",
      )
    )[0];
    if (!current)
      throw new DocumentDraftError("Commercial draft was not observable after creation");
    if (
      !(
        await db.execute(
          sql`insert into audit_log(org_id,actor_id,table_name,row_id,action,changes)
    values(${input.orgId},${input.actorId},'documents',${draft.id},'insert',${JSON.stringify({ reason: "Created commercial agreement document", kind: input.kind, request: input.body })}::jsonb) returning id`,
          "objects",
        )
      )[0]
    )
      throw new DocumentDraftError("Commercial draft audit could not be saved");
    const deferredUpdate = await applyDocumentEdit(
      draft.id,
      current,
      { ...input.body, expectedUpdatedAt: current.updatedAt },
      {
        orgId: input.orgId,
        userId: input.actorId,
        allowedSubsidiaryIds: allowed,
        source: "api",
        deferFlows: true,
        commercialKind: input.kind,
      },
    );
    return {
      status: "created",
      id: draft.id,
      documentNumber: draft.documentNumber,
      deferredUpdate: deferredUpdate ?? null,
    };
  });
}
