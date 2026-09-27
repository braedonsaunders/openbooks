import { type ComponentProps } from 'react'
import { NewWarehouseButton, NewWarehouseDrawer } from '../../app/(app)/warehouse/NewWarehouseDrawer'
import { PutawayQueue } from '../../app/(app)/warehouse/PutawayQueue'
import { WarehousesPanel } from '../../app/(app)/warehouse/WarehousesPanel'
import { str, type WidgetRenderer } from './widget-props'

/** Warehouse cockpit adapters: the tie-out hero, the putaway queue, and the create drawer. */
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
} satisfies Record<string, WidgetRenderer>
