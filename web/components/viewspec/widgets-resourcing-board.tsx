import type { ComponentProps } from 'react'
import {
  StaffingBoard,
  DemandRail,
  AssignmentDrawer,
} from './native-widgets.client'
import { type WidgetRenderer } from './widget-props'

/** Resourcing board, demand and assignment-drawer adapters. */
export const RESOURCING_BOARD_WIDGETS = {
  'resourcing-board': (props) => {
    const board = props as unknown as ComponentProps<typeof StaffingBoard>
    return <StaffingBoard {...board} />
  },
  'resourcing-demand-rail': (props) => {
    const demand = props as unknown as ComponentProps<typeof DemandRail>
    return <DemandRail {...demand} />
  },
  'resourcing-assignment-drawer': (props) => {
    const drawer = props.drawer as ComponentProps<typeof AssignmentDrawer> | null
    if (!drawer) return null
    return <AssignmentDrawer key={drawer.remountKey} {...drawer} canManage={props.canManage === true} />
  },
} satisfies Record<string, WidgetRenderer>
