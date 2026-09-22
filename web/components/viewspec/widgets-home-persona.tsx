import type { ComponentProps } from 'react'
import { InboxTaskList } from '../../app/(app)/inbox/InboxTaskList'
import { str, type WidgetRenderer } from './widget-props'

/**
 * HR-15 persona-home widgets: the inbox task list for the unified inbox
 * page plus the dashboard persona tiles (inbox-list, celebrations-list,
 * announcements-card, pay-tile, balance-tile, whos-out-strip, and the
 * manager/admin tiles). Verbatim adapters only — every widget re-checks
 * its permission the way its native surface does.
 */
export const PERSONA_WIDGETS: Record<string, WidgetRenderer> = {
  'inbox-task-list': (props) => (
    <InboxTaskList
      rows={(props.rows as ComponentProps<typeof InboxTaskList>['rows']) ?? []}
      users={(props.users as ComponentProps<typeof InboxTaskList>['users']) ?? []}
      labels={{
        open: str(props, 'openLabel') ?? 'Open',
        acted: str(props, 'actedLabel') ?? 'Done',
        delegatePlaceholder:
          str(props, 'delegatePlaceholder') ?? 'Delegate to…',
      }}
    />
  ),
}
