/**
 * Stable IDs used when an installed app participates in a host surface.
 * App keys cannot contain `:`, so the prefix is unambiguous and cannot
 * collide with built-in dashboard widget IDs or insight-card UUIDs.
 */
export const APP_WIDGET_PREFIX = 'app:'

const APP_KEY = /^[a-z][a-z0-9-]*$/

export function appWidgetId(key: string): string {
  if (!APP_KEY.test(key)) throw new Error(`invalid app key: ${key}`)
  return `${APP_WIDGET_PREFIX}${key}`
}

export function appKeyFromWidgetId(id: string): string | null {
  if (!id.startsWith(APP_WIDGET_PREFIX)) return null
  const key = id.slice(APP_WIDGET_PREFIX.length)
  return APP_KEY.test(key) ? key : null
}

export function isAppWidgetId(id: string): boolean {
  return appKeyFromWidgetId(id) !== null
}
