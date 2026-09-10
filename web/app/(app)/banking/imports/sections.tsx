import Link from 'next/link'
import { Badge } from '@openbooks/ui'

/**
 * The live bank-feed connections panel on the statement import page.
 *
 * Every row is a bundle of conditional pairs the spec language must never
 * express — a last-attempt date vs nothing, an error line vs nothing, a
 * paused marker vs nothing, a connected/default badge — so the loader passes
 * raw feed rows plus labels and every decision lives here, in one
 * implementation shared by the native page and the spec path.
 */

export interface FeedConnectionRow {
  name: string
  provider: string
  status: string
  last_sync_at: string | null
  last_attempt_at: string | null
  last_error: string | null
  is_active: boolean
  account_number: string | null
  account_name: string
}

export interface BankFeedRow {
  name: string
  provider: string
  accountNumber: string | null
  accountName: string
  status: string
  statusConnected: boolean
  showPaused: boolean
  lastSyncAt: string | null
  lastAttemptAt: string | null
  lastError: string | null
}

/** Loader-resolved flags; date formatting stays with the render, as native. */
export function mapBankFeedRows(feeds: FeedConnectionRow[]): BankFeedRow[] {
  return feeds.map((feed) => ({
    name: feed.name,
    provider: feed.provider,
    accountNumber: feed.account_number,
    accountName: feed.account_name,
    status: feed.status,
    statusConnected: feed.status === 'connected',
    showPaused: !feed.is_active,
    lastSyncAt: feed.last_sync_at,
    lastAttemptAt: feed.last_attempt_at,
    lastError: feed.last_error,
  }))
}

export interface BankFeedPanelProps {
  title: string
  manageLabel: string
  emptyMessage: string
  lastSyncLabel: string
  lastAttemptLabel: string
  neverLabel: string
  feeds: BankFeedRow[]
}

export function BankFeedPanel({
  title,
  manageLabel,
  emptyMessage,
  lastSyncLabel,
  lastAttemptLabel,
  neverLabel,
  feeds,
}: BankFeedPanelProps) {
  return (
    <section className="mb-4 rounded-lg border border-slate-200 dark:border-slate-800">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2.5 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        <Link href={('/admin/setup/bank-feeds')} className="text-sm text-teal-700 hover:underline dark:text-teal-300">
          {manageLabel}
        </Link>
      </div>
      {feeds.length === 0 ? (
        <p className="px-4 py-3 text-sm text-slate-500 dark:text-slate-400">{emptyMessage}</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {feeds.map((feed, index) => (
            <li key={index} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <span className="font-medium text-slate-900 dark:text-slate-100">{feed.name}</span>
              <Badge variant="outline">{feed.provider}</Badge>
              <span className="text-slate-500 dark:text-slate-400">
                <span className="font-mono text-[13px] font-semibold">{feed.accountNumber}</span> {feed.accountName}
              </span>
              <Badge variant={feed.statusConnected ? 'default' : 'secondary'}>{feed.status}</Badge>
              {feed.showPaused ? <span className="text-xs text-slate-400">(paused)</span> : null}
              <span className="ml-auto text-slate-500 dark:text-slate-400">
                {lastSyncLabel}:{' '}
                {feed.lastSyncAt ? new Date(feed.lastSyncAt).toLocaleDateString('en-CA') : neverLabel}
                {feed.lastError && feed.lastAttemptAt ? (
                  <>
                    {' '}· {lastAttemptLabel}:{' '}
                    {new Date(feed.lastAttemptAt).toLocaleDateString('en-CA')}
                  </>
                ) : null}
              </span>
              {feed.lastError ? <span className="w-full text-xs text-red-600" title={feed.lastError}>⚠ {feed.lastError}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
