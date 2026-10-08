import type { ComponentProps } from 'react'
import {
  MySchedule,
  SchedulingWorkspace,
} from './native-widgets.client'
import { type WidgetRenderer } from './widget-props'

/** The unified scheduling workspace: people boards and task boards. */
export const SCHEDULING_WIDGETS = {
  'scheduling-workspace': (props) => {
    const workspace = props as unknown as ComponentProps<typeof SchedulingWorkspace>
    return <SchedulingWorkspace {...workspace} />
  },
  'scheduling-my-schedule': (props) => (
    <MySchedule
      entries={props.entries as ComponentProps<typeof MySchedule>['entries']}
      from={props.from as ComponentProps<typeof MySchedule>['from']}
      through={props.through as ComponentProps<typeof MySchedule>['through']}
      today={props.today as ComponentProps<typeof MySchedule>['today']}
      refusal={props.refusal as ComponentProps<typeof MySchedule>['refusal']}
    />
  ),
} satisfies Record<string, WidgetRenderer>
