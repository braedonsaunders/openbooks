import 'server-only'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Authz } from '../authz'

export interface AnalyticsReadContext {
  authz: Authz
  slug: string
  projection: 'summary' | 'tab'
  tab: string
  locale: string
  revision: string
  observedAt: number
}

const context = new AsyncLocalStorage<AnalyticsReadContext>()
export const currentAnalyticsRead = () => context.getStore()
export const withAnalyticsRead = <T>(read: AnalyticsReadContext, action: () => Promise<T>) => context.run(read, action)

export function observeAnalyticsSource(at: string): void {
  const read = context.getStore()
  if (read) read.observedAt = Math.min(read.observedAt, Date.parse(at))
}

/** Direct domain readers retain their full contract. Dashboard requests only
 * resolve the sections belonging to the selected view. */
export function analyticsSection(slug: string, tabs: readonly string[]): boolean {
  const read = context.getStore()
  return !read || read.slug !== slug || (read.projection === 'tab' && tabs.includes(read.tab))
}
