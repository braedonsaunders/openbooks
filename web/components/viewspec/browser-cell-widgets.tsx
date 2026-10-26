import { PartyLinkCell } from '../../app/(app)/reports/aging/sections'
import { EntryCell } from '../../app/(app)/reports/general-ledger/sections'
import { str, type WidgetRenderer } from './widget-props'

/**
 * Cell widgets whose renderer is a plain component, so report rows can render
 * them in the browser as well as on the server. The server widget registry
 * refers to these entries, keeping one renderer per widget.
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
