import { z } from "zod";
import { documentEditBodySchema } from "@/lib/api/document-edit-schema";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { parseJsonBody } from "@/lib/api/json";
import { isDocumentRevisionToken } from "@/lib/api/registry-data";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { deleteDocument, DeleteError } from "@openbooks/engine/ledger/document-delete";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { checkFlowLock, userRoleKeys } from "@openbooks/engine/flows/module";
import { getAuthz, can, guardSubsidiaryScope, subsidiariesInScope } from "../../../../lib/authz";
import { isUuid } from "../../../../lib/list-params";
import { isDocKindEnabled } from "@openbooks/engine/documents/write";
import {
  editDocumentInLockedScope,
  linesUseDisabledItemKinds,
} from "@openbooks/engine/ledger/document-editing";
import {
  DOCUMENT_EDIT_VERSION_REQUIRED,
  DocumentEditError,
} from "@openbooks/engine/records/document-edit-policy";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { loadDocument } from "@openbooks/engine/ledger/document-service";
import { DOC_KINDS, createPermission } from "../../../../lib/document-kinds.ts";
import { canReadDocumentKind } from "../../../../lib/flow-subject-authz.ts";
import { lockedDocumentScopeDenied } from "../../../../lib/document-scope.ts";
import {
  type DocumentEditCurrent,
  type DocumentEditInput,
} from "@openbooks/engine/ledger/document-input";
import { notFound } from "@/lib/api/responses";
import { customFieldViewerFor } from "../../../../lib/custom-fields";
// An absent body is an empty edit; it is refused in the handler after the
// existence, scope and permission gates so an unreadable or unknown id keeps
// its 404 contract.
const PATCHBodySchema1 = documentEditBodySchema.default({});

export const runtime = "nodejs";

export const GET = defineRoute({
  public: "session",
  handler: async ({ params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const owned = await db.execute<{ kind: string; subsidiaryId: string | null }>(
      sql`select kind, subsidiary_id as "subsidiaryId" from documents where id = ${id} and org_id = ${authz.user.orgId}`,
      "objects",
    );
    const row = owned[0];
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
 * audit, and on_update flows are the engine's document editing service (the
 * same edit core the REST API, MCP and assistant use), so the write paths can
 * never diverge.
 */
export const PATCH = defineRoute({
  public: "session",
  body: PATCHBodySchema1,
  invalidBodyStatus: 422,
  handler: async ({ params: routeParams, body: routeBody }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const user = authz.user;
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const owned = await db.execute<DocumentEditCurrent & { subsidiaryId: string | null }>(
      sql`select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
                   document_date as "documentDate",
                   custom,
                   ${documentRevisionCounterSql(sql.raw("revision_seq"))} as "updatedAt",
                   subsidiary_id as "subsidiaryId"
              from documents where id = ${id} and org_id = ${user.orgId}`,
      "objects",
    );
    const row = owned[0];
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
    // A new line item whose kind's feature is off reads as missing; items
    // already on the draft stay editable.
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
  public: "session",
  handler: async ({ request: req, params: routeParams }) => {
    const params = Promise.resolve(routeParams as { id: string });
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    const { id } = await params;
    if (!isUuid(id)) return notFound("record");
    const owned = await db.execute<{ kind: string; subsidiaryId: string | null }>(
      sql`select kind, subsidiary_id as "subsidiaryId" from documents where id = ${id} and org_id = ${authz.user.orgId}`,
      "objects",
    );
    const row = owned[0];
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
    try {
      // An omitted token is missing input, not a state conflict: it refuses
      // as a bad request, while a supplied token that is not the current
      // revision keeps the conflict refusal below.
      const routeBodySchema2 = z.object({
        reason: z.string().optional(),
        expectedUpdatedAt: z.string().min(1).optional(),
      });
      const parsedBody2 = await parseJsonBody(req, routeBodySchema2);
      if (!parsedBody2.ok) return parsedBody2.response;
      const body = parsedBody2.data as { reason?: string; expectedUpdatedAt?: string };
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
