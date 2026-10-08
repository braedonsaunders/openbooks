import type { ComponentProps } from 'react'
import { DemandDrawer } from './native-widgets.client'
import type { WidgetRenderer } from './widget-props'

/** Demand-list widgets. */
export const RESOURCING_DEMAND_WIDGETS = {
  'resourcing-demand-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof DemandDrawer>['drawer'] | null
    return drawer ? <DemandDrawer key={drawer.remountKey} drawer={drawer} /> : null
  },
} satisfies Record<string, WidgetRenderer>
