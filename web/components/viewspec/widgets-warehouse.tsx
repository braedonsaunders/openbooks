import { type ComponentProps } from 'react'
import { NewWarehouseButton, NewWarehouseDrawer } from '../../app/(app)/warehouse/NewWarehouseDrawer'
import { PutawayQueue } from '../../app/(app)/warehouse/PutawayQueue'
import { WarehousesPanel } from '../../app/(app)/warehouse/WarehousesPanel'
import { ReplenishmentProposals } from '../../app/(app)/reports/replenishment/ReplenishmentProposals'
import { PickListDrawer } from '../../app/(app)/picks/PickListDrawer'
import { NewPickListDrawer } from '../../app/(app)/picks/NewPickListDrawer'
import { ShipmentDrawer } from '../../app/(app)/shipments/ShipmentDrawer'
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
  'pick-list-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof PickListDrawer>['data'] | null
    if (!drawer) return null
    return <PickListDrawer key={drawer.document.id} data={drawer} />
  },
  'new-pick-list-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof NewPickListDrawer>['data'] | null
    if (!drawer) return null
    return <NewPickListDrawer key={drawer.salesOrder.id} data={drawer} />
  },
  'shipment-drawer': (props) => {
    const drawer = props.drawer as (ComponentProps<typeof ShipmentDrawer>['data'] & { initialMode?: 'view' | 'edit' }) | null
    if (!drawer) return null
    const { initialMode, ...data } = drawer
    return <ShipmentDrawer key={data.document.id} data={data} initialMode={initialMode} />
  },
} satisfies Record<string, WidgetRenderer>
