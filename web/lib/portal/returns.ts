import 'server-only'

import { randomUUID } from 'node:crypto'
import { db, withOrgContext } from '@openbooks/engine/platform/database'
import { businessToday } from '@openbooks/engine/platform/business-date'
import {
  PORTAL_ACTOR_ID,
  portalRefusal,
  readPortalSettings,
  recordPortalEvent,
  resolvePortalSession,
  validatePortalReturn,
} from '@openbooks/engine/portal'
import { returnableSources } from '@openbooks/engine/inventory'
import { isFeatureEnabled } from '@/lib/features'
import { createReturnAuthorization, type ReturnSourceSelection } from '@/lib/returns'

/** Resolve a portal session token or 404 without disclosing why. */
export async function portalSessionOrThrow(token: string) {
  const session = await resolvePortalSession(token)
  if (!session) {
    throw portalRefusal('This portal session is invalid or expired', 'invalid_link', 404, 'Request a new sign-in link from the portal sign-in')
  }
  return session
}

/**
 * A customer return request: validate against the org's portal return
 * rules, create the draft RMA through the standard return pipeline (same
 * numbering, flows and authorization as an operator RMA), and audit the
 * customer action. The RMA carries the requested resolution so inspection
 * settles it as refund, exchange or store credit with the configured bonus.
 */
export async function requestPortalReturn(input: {
  sessionToken: string
  sourceDocumentId: string
  reasonCode: string
  resolution: 'refund' | 'exchange' | 'store_credit'
  lines: Array<{ sourceIssueMovementId: string; quantity: unknown }>
}) {
  const session = await portalSessionOrThrow(input.sessionToken)
  const { orgId, partyId, linkId } = session
  const settings = await withOrgContext(orgId, () => readPortalSettings(orgId, db))
  if (!settings.sections.returns) {
    throw portalRefusal('Self-service returns are turned off for this supplier', 'feature_disabled', 404, 'Contact your supplier — they can file the return on your behalf')
  }
  const validated = await validatePortalReturn(orgId, partyId, {
    sourceDocumentId: input.sourceDocumentId,
    reasonCode: input.reasonCode,
    resolution: input.resolution,
    lines: input.lines,
  })
  const today = await withOrgContext(orgId, () => businessToday(orgId))
  const selections: ReturnSourceSelection[] = validated.lines.map((line, index) => ({
    lineNumber: index + 1,
    sourceIssueMovementId: line.sourceIssueMovementId,
  }))
  const multiCurrency = await isFeatureEnabled(orgId, 'multiCurrency')
  const authorization = await createReturnAuthorization({
    orgId,
    actorId: PORTAL_ACTOR_ID,
    key: randomUUID(),
    onBehalfOfPartyId: partyId,
    body: {
      partyId,
      subsidiaryId: validated.subsidiaryId,
      documentDate: today,
      ...(multiCurrency ? { currency: validated.currency } : {}),
      memo: `Customer portal return (${validated.reasonCode} → ${validated.resolution})`,
      custom: {
        portalRequest: {
          partyId, linkId, reasonCode: validated.reasonCode, resolution: validated.resolution,
          storeCreditBonusPercent: validated.storeCreditBonusPercent, sourceDocumentId: validated.sourceDocumentId,
        },
      },
      lines: validated.lines.map((line) => ({ quantity: line.quantity })),
    },
    sourceSelections: selections,
    requestBody: { portal: true },
    allowedSubsidiaryIds: null,
  })
  await withOrgContext(orgId, async () => {
    await recordPortalEvent(db, orgId, {
      partyId, linkId, action: 'return_requested', reasonCode: validated.reasonCode,
      detail: {
        rmaId: authorization.id, documentNumber: authorization.documentNumber,
        sourceDocumentId: validated.sourceDocumentId, resolution: validated.resolution,
        storeCreditBonusPercent: validated.storeCreditBonusPercent,
      },
    })
  })
  return authorization
}

/** Returnable shipments for one customer source document, scoped to the session party. */
export async function portalReturnableSources(sessionToken: string, sourceDocumentId: string) {
  const session = await portalSessionOrThrow(sessionToken)
  const page = await withOrgContext(session.orgId, () =>
    returnableSources(db, session.orgId, { side: 'sales', partyId: session.partyId, limit: 200 }))
  return page.sources.filter((source) => source.documentId === sourceDocumentId)
}
