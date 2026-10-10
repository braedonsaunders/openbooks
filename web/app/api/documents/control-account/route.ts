import { NextResponse } from 'next/server'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  controlAccountChoices,
  controlAccountLookupScope,
  DOCUMENT_CONTROL_SIDE,
} from '@openbooks/engine/src/ledger/posting-control-account.ts'
import { guardPermission, guardSubsidiaryScope } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { readPermission } from '../../../../lib/document-kinds'
import { isDocKindEnabled } from '../../../../lib/documents.ts'
import { notFound } from '@/lib/api/responses'
import { defineRoute } from '@/lib/api/route'

export const runtime = 'nodejs'

const KIND_REFUSAL = 'kind must be customer_invoice, customer_credit, vendor_bill or vendor_credit'

/**
 * The receivable/payable account picker of a party document (invoice, credit
 * memo, bill, vendor credit): the accounts a document may choose, plus the
 * party default and the organization control an empty choice resolves to.
 * Read-only. The document edit boundary and the posting kernel re-validate
 * any choice, so this endpoint confers nothing beyond what it lists.
 */
async function getControlAccountChoices(request: Request) {
  const url = new URL(request.url)
  const kind = url.searchParams.get('kind') ?? ''
  if (!DOCUMENT_CONTROL_SIDE[kind]) return NextResponse.json({ error: KIND_REFUSAL }, { status: 400 })
  const gate = await guardPermission(readPermission(kind))
  if (gate instanceof NextResponse) return gate
  if (!(await isDocKindEnabled(gate.user.orgId, kind))) return notFound('record')

  const partyId = url.searchParams.get('partyId') || null
  const subsidiaryId = url.searchParams.get('subsidiaryId') || null
  const accountId = url.searchParams.get('accountId') || null
  const documentId = url.searchParams.get('documentId') || null
  for (const [name, value] of [['partyId', partyId], ['subsidiaryId', subsidiaryId], ['accountId', accountId], ['documentId', documentId]] as const) {
    if (value !== null && !isUuid(value)) {
      return NextResponse.json({ error: `${name} must be a UUID` }, { status: 400 })
    }
  }
  // The party and the document are record boundaries: each must exist in
  // this organization (the document as this kind) and inside the reader's
  // subsidiary scope. Null-subsidiary parties are org-wide.
  const scope = await controlAccountLookupScope(db, { orgId: gate.user.orgId, kind, partyId, documentId })
  if (partyId) {
    if (!scope.party) return notFound('record')
    const denied = guardSubsidiaryScope(gate, scope.party.subsidiaryId, { orgWideNull: true })
    if (denied) return denied
  }
  if (subsidiaryId) {
    const denied = guardSubsidiaryScope(gate, subsidiaryId)
    if (denied) return denied
  }
  if (documentId) {
    if (!scope.document) return notFound('record')
    const denied = guardSubsidiaryScope(gate, scope.document.subsidiaryId)
    if (denied) return denied
  }
  const choices = await controlAccountChoices(db, {
    orgId: gate.user.orgId,
    kind,
    partyId,
    subsidiaryId,
    allowedSubsidiaryIds: gate.allowedSubsidiaryIds,
    selectedAccountId: accountId,
    // A posted document reports the account its open item actually carries.
    postedDocumentId: scope.document?.status === 'posted' ? documentId : null,
  })
  return NextResponse.json(choices)
}

export const GET = defineRoute({
  authorize: async ({ request }) => {
    const kind = new URL(request.url).searchParams.get('kind') ?? ''
    if (!DOCUMENT_CONTROL_SIDE[kind]) return NextResponse.json({ error: KIND_REFUSAL }, { status: 400 })
    return guardPermission(readPermission(kind))
  },
  feature: { none: 'The handler applies the document kind feature gate for the requested kind.' },
  handler: async ({ request }) => getControlAccountChoices(request),
})
