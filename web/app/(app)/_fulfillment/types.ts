import type { FormLayoutConfig } from '@openbooks/customization'
import type { FulfillmentDocumentView } from '@openbooks/engine/src/sales/fulfillment.ts'
import type { CustomFieldDefClient } from '../../../components/custom-field-inputs'

/** A carrier a draft shipment may name (web/lib/fulfillment.ts). */
export interface FulfillmentCarrierOption {
  id: string
  code: string
  name: string
  services: string[]
}

/**
 * Everything a pick-list or shipment drawer renders, assembled by
 * loadFulfillmentDrawerData wherever the record opens (its own list, a
 * related-record flyout), so the drawer reads the same everywhere.
 */
export interface FulfillmentDrawerData {
  document: FulfillmentDocumentView
  /** The resolved customization form for the record type. */
  layout: FormLayoutConfig
  /** Header custom-field definitions and the document's stored values. */
  headerDefs: CustomFieldDefClient[]
  custom: Record<string, unknown>
  /** Active carriers for a draft shipment's carrier picker; empty on a pick list. */
  carriers: FulfillmentCarrierOption[]
  /** orders.fulfill: release, ship, void, carrier and cartons. */
  canManage: boolean
  /** items.post: completing a shipment moves stock. */
  canPost: boolean
  /** List URL the drawer closes to. */
  closeHref: string
}

/** The create-pick-list drawer's server half: the order being picked. */
export interface NewPickListData {
  salesOrder: { id: string; number: string; customerName: string | null }
  layout: FormLayoutConfig
  today: string
  closeHref: string
}
