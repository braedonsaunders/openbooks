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

/** Resolve operational flags on the server; format dates in the viewer's context. */
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
