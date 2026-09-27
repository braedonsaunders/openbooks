import { z } from 'zod';
import { defineRoute } from '@/lib/api/route';
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { guardPermission } from '../../../../lib/authz'
import { createDocumentDraft, DocumentDraftError, isDocKindEnabled } from "../../../../lib/documents.ts";
import { DOC_KINDS, createPermission } from "../../../../lib/document-kinds.ts";
import { notFound } from "@/lib/api/responses";
const POSTBodySchema1 = z.object({ "kind": z.string().optional() }).passthrough();



export const runtime = 'nodejs'

/** Instant-into-draft: create an empty draft document of the given kind. */
export const POST = defineRoute({
  public: 'session',
  body: POSTBodySchema1,
  handler: async ({ request: req , body: routeBody }) => {

    const body = (routeBody) as { kind?: string }
    if (!body.kind || !DOC_KINDS[body.kind]) {
        return NextResponse.json({ error: 'unknown document kind' }, { status: 400 })
      }
    const gate = await guardPermission(createPermission(body.kind))
    if (gate instanceof NextResponse) return gate
    const user = gate.user
    if (!(await isDocKindEnabled(user.orgId, body.kind))) {
        return notFound("record")
      }
    try {
        // A restricted caller's draft lands in their own subsidiary, or a named
        // refusal — never the org root, which excludes their own reads.
        const doc = await createDocumentDraft(user.orgId, user.id, body.kind, {
          allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
        })
        return NextResponse.json(doc)
      } catch (error) {
        if (error instanceof DocumentDraftError) {
          return apiErrorResponse(error)
        }
        throw error
      }
  },
});
