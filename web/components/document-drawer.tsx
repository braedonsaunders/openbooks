'use client'

import type { DocumentDrawerProps } from './document-drawer-props'
import { useDocumentDrawerScope } from './document-drawer-scope'
import { useDocumentDrawerDefaults } from './document-drawer-defaults'
import { useDocumentDrawerDistribution } from './document-drawer-distribution'
import { useDocumentDrawerPickers } from './document-drawer-pickers'
import { useDocumentDrawerPayload } from './document-drawer-payload'
import { buildDocumentDrawerCommands } from './document-drawer-commands'
import { useDocumentDrawerColumns } from './document-drawer-columns'
import { useDocumentDrawerHeader } from './document-drawer-header'
import { renderDocumentDrawerChrome } from './document-drawer-chrome'
import { renderDocumentDrawerBody } from './document-drawer-body'

export { asDocumentDoc, clearedDistributionFields, distributionFieldsOf } from './document-drawer-types'
export type { DistributionLineFields, DocPayload, DocumentDoc } from './document-drawer-types'
export {
  DOCUMENT_CHANGED_AFTER_OPEN,
  buildDocumentCreateRequest,
  buildDocumentSaveRequest,
  buildReturnCreateRequest,
  createdDocumentId,
  draftDocumentIdentity,
  editedDocumentAcknowledged,
  executeDocumentSave,
  findCurrencyMismatchedAccount,
  loadDraftDocumentSnapshot,
  persistedDocumentRevision,
  readDocumentActionResult,
  readDocumentSaveFailure,
  reconcileCanonicalDraftRead,
  reconcilePersistedDocumentSnapshot,
  revisionFromSuccessfulDocumentSave,
} from './document-drawer-save'
export type {
  CanonicalDraftAdoption,
  CurrencyMismatchedAccount,
  DocumentSaveOutcome,
  DocumentSaveRequest,
  FencedSaveResult,
  PersistedDocumentSnapshot,
  RevisionFencedRequest,
} from './document-drawer-save'
export { DocumentDrawerTitle } from './document-drawer-title'
export {
  NO_RETURN_SENTINEL,
  applyQtyPriceToRows,
  computeDocumentDrawerTotals,
  findMissingAccountLine,
  hasDrawerLineAccount,
  isBlankDrawerLine,
  lineAmountFromQtyPrice,
  returnCellPayload,
} from './document-drawer-lines'
export type { DocumentDrawerTotals } from './document-drawer-lines'
export type { DocumentDrawerProps } from './document-drawer-props'

/**
 * The shared transaction drawer for every document kind. Each stage reads
 * the scope built by the stages before it, in a fixed order, so hook order
 * and effect order stay identical on every render.
 */
export function DocumentDrawer(props: DocumentDrawerProps) {
  const scope = useDocumentDrawerScope(props)
  const withDefaults = { ...scope, ...useDocumentDrawerDefaults(scope) }
  const withDistribution = { ...withDefaults, ...useDocumentDrawerDistribution(withDefaults) }
  const withPickers = { ...withDistribution, ...useDocumentDrawerPickers(withDistribution) }
  const withPayload = { ...withPickers, ...useDocumentDrawerPayload(withPickers) }
  const withCommands = { ...withPayload, ...buildDocumentDrawerCommands(withPayload) }
  const withColumns = { ...withCommands, ...useDocumentDrawerColumns(withCommands) }
  const drawer = { ...withColumns, ...useDocumentDrawerHeader(withColumns) }
  return renderDocumentDrawerChrome(drawer, renderDocumentDrawerBody(drawer))
}
