import { z } from 'zod'
import { defineRoute } from '@/lib/api/route'
import { apiErrorResponse } from '@/lib/api/error-response'
import { NextResponse } from 'next/server'
import { notFound } from '@/lib/api/responses'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  DocumentDefaultsError,
  resolveDocumentLineDefaults,
  resolveTermsDueDate,
} from '@openbooks/engine/src/ledger/document-defaults.ts'
import { guardPermission } from '../../../../lib/authz'
import { isDocKindEnabled } from '../../../../lib/documents.ts'
import { DOC_KINDS, documentEditPermission } from '../../../../lib/document-kinds.ts'

const DefaultsQuerySchema = z.object({
  kind: z.enum(Object.keys(DOC_KINDS) as [string, ...string[]]),
  partyId: z.string().uuid().optional(),
  documentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  itemIds: z.array(z.string().uuid()).max(200),
})

export const runtime = 'nodejs'

/**
 * Header and line defaults for a document being edited, before it is saved:
 * the due date the party's payment terms imply (`documentDate` + `partyId`),
 * and each `itemId`'s account and tax code. Read-only — the same resolver the
 * create path applies — so the drawer shows exactly what the server derives.
 */
export const GET = defineRoute({
  public: 'session',
  handler: async ({ request }) => {
    const params = new URL(request.url).searchParams
    const parsed = DefaultsQuerySchema.safeParse({
      kind: params.get('kind') ?? undefined,
      partyId: params.get('partyId') || undefined,
      documentDate: params.get('documentDate') || undefined,
      itemIds: params.getAll('itemId'),
    })
    if (!parsed.success) {
      return NextResponse.json({ error: 'Name a document kind, and use a valid party, document date (YYYY-MM-DD) and item ids' }, { status: 400 })
    }
    const query = parsed.data
    const gate = await guardPermission(documentEditPermission(query.kind))
    if (gate instanceof NextResponse) return gate
    const orgId = gate.user.orgId
    if (!(await isDocKindEnabled(orgId, query.kind))) return notFound('record')
    try {
      const [terms, lines] = await Promise.all([
        query.documentDate
          ? resolveTermsDueDate(db, orgId, { kind: query.kind, partyId: query.partyId, documentDate: query.documentDate })
          : Promise.resolve(null),
        resolveDocumentLineDefaults(db, orgId, { kind: query.kind, partyId: query.partyId, itemIds: query.itemIds }),
      ])
      return NextResponse.json({ terms, lines })
    } catch (error) {
      if (error instanceof DocumentDefaultsError) return apiErrorResponse(error)
      throw error
    }
  },
})
