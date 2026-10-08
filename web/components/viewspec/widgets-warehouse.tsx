import {
  NativeListDrawer,
  NewWarehouseButton,
  NewWarehouseDrawer,
  PutawayQueue,
  WarehousesPanel,
  ReplenishmentProposals,
  NewPickListDrawer,
  BulkBuyClient,
} from './native-widgets.client'
import { type ComponentProps } from 'react'
import { str, type WidgetRenderer } from './widget-props'

/** Warehouse adapters: the cockpit's tie-out hero, putaway queue and create
 *  drawer; the Replenishment report's proposal lines; and the fulfilment
 *  drawers placed by the pick-list and shipment lists. Each drawer is keyed
 *  by its record so switching records resets its client state. */
export const WAREHOUSE_WIDGETS = {
  'warehouses-panel': (props) => (
    <WarehousesPanel
      rows={(props.rows as ComponentProps<typeof WarehousesPanel>['rows']) ?? []}
      canManage={props.canManage === true}
      currentParams={(props.currentParams as ComponentProps<typeof WarehousesPanel>['currentParams']) ?? {}}
      layerTotalLabel={str(props, 'layerTotalLabel') ?? ''}
      controlLabel={str(props, 'controlLabel') ?? ''}
      controlDrill={(props.controlDrill as ComponentProps<typeof WarehousesPanel>['controlDrill']) ?? null}
      differenceLabel={str(props, 'differenceLabel') ?? ''}
      differenceIsZero={props.differenceIsZero === true}
    />
  ),
  'putaway-queue': (props) => (
    <PutawayQueue
      rows={(props.rows as ComponentProps<typeof PutawayQueue>['rows']) ?? []}
      canPost={props.canPost === true}
    />
  ),
  'new-warehouse-button': (props) => <NewWarehouseButton label={str(props, 'label') ?? ''} />,
  'new-warehouse-drawer': (props) => (
    <NewWarehouseDrawer
      locations={(props.locations as ComponentProps<typeof NewWarehouseDrawer>['locations']) ?? []}
      closeHref={str(props, 'closeHref') ?? '/warehouse'}
    />
  ),
  'replenishment-proposals': (props) => (
    <ReplenishmentProposals
      rows={(props.rows as ComponentProps<typeof ReplenishmentProposals>['rows']) ?? []}
      orderSubsidiaryId={str(props, 'orderSubsidiaryId') ?? null}
      canOrder={props.canOrder === true}
    />
  ),
  'pick-list-drawer': (props) => <NativeListDrawer widget="pick-list-drawer" drawer={props.drawer} />,
  'new-pick-list-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof NewPickListDrawer>['data'] | null
    if (!drawer) return null
    return <NewPickListDrawer key={drawer.salesOrder.id} data={drawer} />
  },
  'shipment-drawer': (props) => <NativeListDrawer widget="shipment-drawer" drawer={props.drawer} />,
  /** Bulk label buying owns its selection, rule, preview and buy: client
   *  state a spec cannot name, like the capture list's. */
  'shipping-bulk-buy': (props) => (
    <BulkBuyClient
      accounts={(props.accounts as ComponentProps<typeof BulkBuyClient>['accounts']) ?? []}
      canBuy={props.canBuy === true}
    />
  ),
} satisfies Record<string, WidgetRenderer>
