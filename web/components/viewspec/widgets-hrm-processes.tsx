import type { ComponentProps } from 'react'
import { NewHrmButton } from '../../app/(app)/hrm/NewHrmButton'
import { ProcessCreateDrawer } from '../../app/(app)/hrm/processes/ProcessCreateDrawer'
import { str, type WidgetRenderer } from './widget-props'

/** HRM process authoring entry points, isolated so registry families stay bounded. */
export const HRM_PROCESS_WIDGETS = {
  'hrm-new-menu': (props) => (
    <NewHrmButton
      canCreateEmployee={props.canCreateEmployee === true}
      canProposeChange={props.canProposeChange === true}
      canCreateProcess={props.canCreateProcess === true}
      employeeLabel={str(props, 'employeeLabel') ?? ''}
      changeLabel={str(props, 'changeLabel') ?? ''}
      processLabel={str(props, 'processLabel') ?? ''}
    />
  ),
  'hrm-process-create': (props) => (
    <ProcessCreateDrawer create={(props.create as ComponentProps<typeof ProcessCreateDrawer>['create']) ?? null} />
  ),
} satisfies Record<string, WidgetRenderer>
