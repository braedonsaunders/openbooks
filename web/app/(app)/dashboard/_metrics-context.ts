import 'server-only'
import type { Authz } from '@/lib/authz'
import type { ResolvedPeriod } from '@/lib/periods'

/**
 * What every dashboard widget reader receives. Readers for widgets extracted
 * from an Analytics dashboard compute their figures through that dashboard's
 * own loaders, over the same subsidiary scope and — for period figures — the
 * same period the dashboard opens on, so a widget and its dashboard can never
 * disagree.
 */
export type DashboardWidgetContext = {
  authz: Authz
  orgId: string
  /** The org's business date (its configured time zone). */
  today: string
  /** Subsidiary ids for readers taking a list; undefined when unrestricted. */
  subsidiaryIds: string[] | undefined
  allowedSubsidiaryIds: ReadonlySet<string> | null
  /**
   * The period an Analytics dashboard opens on, resolved once per request
   * through the organization's fiscal calendar.
   */
  period: () => Promise<ResolvedPeriod>
}

/**
 * A widget value that may be unavailable. An unavailable value carries the
 * reason, already translated, so the tile can say WHY it shows no figure —
 * an absent figure never renders as zero.
 */
export type WidgetValue<T> = { available: true; value: T } | { available: false; reason: string }
