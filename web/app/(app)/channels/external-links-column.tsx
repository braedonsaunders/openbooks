import type { SetupColumn } from '../../../lib/setup/registry'
import { UnlinkExternalLinkButton } from './UnlinkExternalLinkButton'

/**
 * Record-drawer External IDs tabs stay read-only rows with one audited
 * action: the unlink button beside the external id. Channel-less provider
 * links render no button — their owning surface unlinks them.
 */
export function externalLinkUnlinkColumn(canManage: boolean) {
  return function renderExternalIdCell(column: SetupColumn, row: Record<string, unknown>) {
    if (column.key !== 'externalId') return undefined
    const channelId = typeof row.channel_id === 'string' ? row.channel_id : null
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span className="font-mono">{String(row.external_id ?? '')}</span>
        <UnlinkExternalLinkButton
          channelId={channelId}
          provider={String(row.provider ?? '')}
          externalAccount={String(row.external_account ?? '')}
          objectType={String(row.object_type ?? '')}
          externalId={String(row.external_id ?? '')}
          canManage={canManage}
        />
      </span>
    )
  }
}
