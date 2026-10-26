import { z } from "zod";
import { documentEditBodySchema } from "@/lib/api/document-edit-schema";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { NextResponse } from "next/server";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { deleteDocument, DeleteError } from "@openbooks/engine/ledger/document-delete";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { checkFlowLock, userRoleKeys } from "@openbooks/engine/flows/module";
import { getAuthz, can, guardSubsidiaryScope, subsidiariesInScope, type Authz } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
import { isDocKindEnabled } from "@openbooks/engine/documents/write";
import {
  editDocumentInLockedScope,
  linesUseDisabledItemKinds,
} from "@openbooks/engine/ledger/document-editing";
import {
  DOCUMENT_EDIT_VERSION_REQUIRED,
  DocumentEditError,
} from "@openbooks/engine/records/document-edit-policy";
import { loadDocument } from "@openbooks/engine/ledger/document-service";
import { DOC_KINDS, createPermission } from "@/lib/document-kinds.ts";
import { canReadDocumentKind } from "@/lib/flow-subject-authz.ts";
import { lockedDocumentScopeDenied } from "@/lib/document-scope.ts";
import { type DocumentEditInput } from "@openbooks/engine/ledger/document-input";
import { loadDocumentEditCurrent, loadDocumentKindScope } from "@openbooks/engine/ledger/document-edit-queries";
import { notFound } from "@/lib/api/responses";
import { customFieldViewerFor } from "@/lib/custom-fields";
// An absent body is an empty edit; it is refused in the handler after the
// existence, scope and permission gates so an unreadable or unknown id keeps
// its 404 contract.
const PATCHBodySchema1 = documentEditBodySchema.default({});
const deleteBodySchema = z.object({
  reason: z.string().optional(),
  expectedUpdatedAt: z.string().min(1).optional(),
});
const authorizedDeleteIds = new WeakMap<Authz, string>();

export const runtime = "nodejs";

export const GET = defineRoute({
  public: "session",
  handler: async ({ params: routeParams, authz }) => {
    const { id } = routeParams as { id: string };
    if (!isUuid(id)) return notFound("record");
    const row = await loadDocumentKindScope(authz.user.orgId, id);
    if (!row) return notFound("record");
    const denied = guardSubsidiaryScope(authz, row.subsidiaryId);
    if (denied) return denied;
    if (!(await isDocKindEnabled(authz.user.orgId, row.kind))) {
      return notFound("record");
    }
    if (!DOC_KINDS[row.kind]) {
      return NextResponse.json({ error: `kind "${row.kind}" is not served here` }, { status: 422 });
    }
    if (!canReadDocumentKind(authz, row.kind)) {
      return notFound("record");
    }
    const doc = await loadDocument(id, authz.user.orgId, customFieldViewerFor(authz));
    if (!doc) return notFound("record");
    const redisclosed = guardSubsidiaryScope(authz, doc.doc.subsidiary_id as string | null);
    if (redisclosed) return redisclosed;
    return NextResponse.json(doc);
  },
});

/**
 * Save a posting document. Auth + status/lock guards live here; the locked
 * scope recheck, header + lines write, GL re-materialization, transaction
 * audit, and on_update flows are the engine's document editing service, so
 * the write paths can never diverge.
 */
export const PATCH = defineRoute({
  public: "session",
  body: PATCHBodySchema1,
  opaque: {
    expectedUpdatedAt:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    lines:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    subsidiaryId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    partyId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    paymentCardId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    documentDate:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    dueDate:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    referenceNumber:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    memo: "Partial edits accept independent fields; empty edits are refused after document authorization.",
    postingDate:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    departmentId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    projectId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    locationId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    classId:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    extraDims:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    expectedPayDate:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    workCompletedOn:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    paymentHoldReason:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    internalNotes:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    billingMethod:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    isFinalInvoice:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    currency:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    explicitFx:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    custom:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
    unsplitDistributionGroups:
      "Partial edits accept independent fields; empty edits are refused after document authorization.",
  },
  invalidBodyStatus: 422,
  handler: async ({ params: routeParams, authz, body: routeBody }) => {
    const user = authz.user;
    const { id } = routeParams as { id: string };
    if (!isUuid(id)) return notFound("record");
    const row = await loadDocumentEditCurrent(user.orgId, id);
    if (!row) return notFound("record");
    const denied = guardSubsidiaryScope(authz, row.subsidiaryId);
    if (denied) return denied;
    if (!(await isDocKindEnabled(user.orgId, row.kind))) {
      return notFound("record");
    }
    const cfg = DOC_KINDS[row.kind];
    if (!cfg)
      return NextResponse.json(
        { error: `kind "${row.kind}" is not editable here` },
        { status: 422 },
      );
    if (!canReadDocumentKind(authz, row.kind)) {
      return notFound("record");
    }
    const editPerm = row.kind === "project_charge" ? "projects.manage" : createPermission(row.kind);
    if (!can(authz, editPerm)) {
      return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 });
    }
    if (row.status !== "draft") {
      return NextResponse.json(
        {
          error: `a ${row.status} document cannot be edited — return it to draft or create a controlled correction`,
        },
        { status: 422 },
      );
    }
    {
      const roles = await userRoleKeys(user.orgId, user.id);
      const lock = await checkFlowLock(row.kind, id, {
        isAdmin: user.isSuperAdmin || roles.has("admin"),
        roles: [...roles],
      });
      if (lock) {
        return NextResponse.json(
          {
            error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ""}`,
          },
          { status: 409 },
        );
      }
    }

    const body = routeBody as DocumentEditInput;
    if (Object.keys(body).length === 0) {
      return NextResponse.json({ error: "At least one field must be provided." }, { status: 400 });
    }
    if (body.subsidiaryId !== undefined && !subsidiariesInScope(authz, [body.subsidiaryId])) {
      return NextResponse.json({ error: "invalid subsidiary" }, { status: 422 });
    }
    if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
      return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 409 });
    }
    // New lines whose item kind is gated by a disabled feature read as
    // missing; items already on this draft remain editable.
    if (
      Array.isArray(body.lines) &&
      (await linesUseDisabledItemKinds(user.orgId, body.lines, id))
    ) {
      return notFound("record");
    }
    try {
      // The edit and the locked scope recheck commit as one unit: a rehome
      // that landed after the precheck meets the uniform 404 and writes
      // nothing, instead of editing another subsidiary's document.
      await editDocumentInLockedScope(
        {
          orgId: user.orgId,
          userId: user.id,
          source: "ui",
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          customFieldViewer: customFieldViewerFor(authz),
        },
        { documentId: id, current: row, body },
      );
    } catch (e) {
      if (e instanceof DocumentEditError) {
        return apiErrorResponse(e, {
          details: e.fieldErrors ? { fieldErrors: e.fieldErrors } : undefined,
        });
      }
      throw e;
    }
    const doc = await loadDocument(id, user.orgId, customFieldViewerFor(authz));
    return NextResponse.json(doc);
  },
});

/** Delete a document (guarded: open period, no applied payments, no downstream conversion). */
export const DELETE = defineRoute({
  authorize: async ({ params }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const rawId = (params as { id?: unknown } | undefined)?.id;
    if (typeof rawId !== "string") return notFound("record");
    const id = rawId;
    if (!isUuid(id)) return notFound("record");
    const row = await loadDocumentKindScope(authz.user.orgId, id);
    if (!row) return notFound("record");
    const denied = guardSubsidiaryScope(authz, row.subsidiaryId);
    if (denied) return denied;
    if (!(await isDocKindEnabled(authz.user.orgId, row.kind))) {
      return notFound("record");
    }
    const cfg = DOC_KINDS[row.kind];
    if (!cfg)
      return NextResponse.json(
        { error: `kind "${row.kind}" is not editable here` },
        { status: 422 },
      );
    if (!canReadDocumentKind(authz, row.kind)) {
      return notFound("record");
    }
    const editPerm = row.kind === "project_charge" ? "projects.manage" : createPermission(row.kind);
    if (!can(authz, editPerm)) {
      return NextResponse.json({ error: `missing permission: ${editPerm}` }, { status: 403 });
    }
    {
      const roles = await userRoleKeys(authz.user.orgId, authz.user.id);
      const lock = await checkFlowLock(row.kind, id, {
        isAdmin: authz.user.isSuperAdmin || roles.has("admin"),
        roles: [...roles],
      });
      if (lock) {
        return NextResponse.json(
          {
            error: `this document is locked by a workflow${lock.reason ? ` — ${lock.reason}` : ""}`,
          },
          { status: 409 },
        );
      }
    }
    authorizedDeleteIds.set(authz, id);
    return authz;
  },
  feature: {
    none: "Deletion checks the selected document kind feature and edit permission before reading its body.",
  },
  params: z.object({ id: z.string() }),
  body: deleteBodySchema,
  opaque: {
    reason:
      "Deletion reason is optional; the revision token is checked after document authorization.",
    expectedUpdatedAt:
      "Deletion reason is optional; the revision token is checked after document authorization.",
  },
  handler: async ({ authz, body }) => {
    const id = authorizedDeleteIds.get(authz);
    if (!id) return notFound("record");
    try {
      // An omitted token is missing input, not a state conflict: it refuses
      // as a bad request, while a supplied token that is not the current
      // revision keeps the conflict refusal below.
      if (body.expectedUpdatedAt === undefined) {
        return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 400 });
      }
      if (!isDocumentRevisionToken(body.expectedUpdatedAt)) {
        return NextResponse.json({ error: DOCUMENT_EDIT_VERSION_REQUIRED }, { status: 409 });
      }
      // The delete and the locked scope recheck commit as one unit: a rehome
      // that landed after the precheck meets the uniform 404 and deletes
      // nothing, instead of deleting another subsidiary's document.
      const denied = await withOrgTransaction(authz.user.orgId, async () => {
        const relocked = await lockedDocumentScopeDenied(authz, id);
        if (relocked) return relocked;
        await deleteDocument(id, authz.user.id, authz.user.orgId, {
          source: "ui",
          reason: body.reason,
          expectedUpdatedAt: body.expectedUpdatedAt,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        });
        return null;
      });
      if (denied) return denied;
      return NextResponse.json({ ok: true });
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound("record");
      if (e instanceof DeleteError) return apiErrorResponse(e);
      throw e;
    }
  },
});
