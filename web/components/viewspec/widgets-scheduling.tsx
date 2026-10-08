import type { ComponentProps } from 'react'
import { MySchedule } from '../scheduling/MySchedule'
import { SchedulingWorkspace } from '../scheduling/SchedulingWorkspace'
import { type WidgetRenderer } from './widget-props'

/** The unified scheduling workspace: people boards and task boards. */
export const SCHEDULING_WIDGETS = {
  'scheduling-workspace': (props) => {
    const workspace = props as unknown as ComponentProps<typeof SchedulingWorkspace>
    return <SchedulingWorkspace {...workspace} />
  },
  'scheduling-my-schedule': (props) => {
    const schedule = props as unknown as ComponentProps<typeof MySchedule>
    return <MySchedule {...schedule} />
  },
} satisfies Record<string, WidgetRenderer>
