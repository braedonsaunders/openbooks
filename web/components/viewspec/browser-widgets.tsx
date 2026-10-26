import type { ComponentProps } from 'react'
import { PartyLinkCell } from '../../app/(app)/reports/aging/sections'
import { AccountHeading, EntryCell } from '../../app/(app)/reports/general-ledger/sections'
import { PartyHeading } from '../../app/(app)/reports/registers/sections'
import { str, type WidgetRenderer } from './widget-props'

/**
 * Widgets whose renderer is a plain component, so long reports can render
 * them in the browser as well as on the server. The server widget registry
 * refers to these entries, keeping one renderer per widget: cell widgets for
 * report rows, block widgets for the headings of grouped report sections.
 */
export const BROWSER_CELL_WIDGETS = {
  'entry-cell': (props) => (
    <EntryCell
      entryId={str(props, 'entryId') ?? ''}
      docKind={(props.docKind as string | null) ?? null}
      docId={(props.docId as string | null) ?? null}
      entryNumber={(props.entryNumber as string | null) ?? null}
    />
  ),
  'party-link-cell': (props) => (
    <PartyLinkCell
      partyId={(props.partyId as string | null) ?? null}
      partyName={str(props, 'partyName') ?? ''}
      href={str(props, 'href') ?? ''}
      note={str(props, 'note')}
    />
  ),
} satisfies Record<string, WidgetRenderer>

export const BROWSER_BLOCK_WIDGETS = {
  'account-heading': (props) => (
    <AccountHeading
      accountId={str(props, 'accountId') ?? ''}
      from={str(props, 'from') ?? ''}
      to={str(props, 'to') ?? ''}
      number={(props.number as string | null) ?? null}
      name={str(props, 'name') ?? ''}
    />
  ),
  'party-heading': (props) => (
    <PartyHeading
      partyId={(props.partyId as string | null) ?? null}
      partyName={str(props, 'partyName') ?? ''}
      statementHref={str(props, 'statementHref') ?? ''}
      closingLabel={str(props, 'closingLabel') ?? ''}
      closing={str(props, 'closing') ?? ''}
      closingDrill={props.closingDrill as ComponentProps<typeof PartyHeading>['closingDrill']}
    />
  ),
} satisfies Record<string, WidgetRenderer>
