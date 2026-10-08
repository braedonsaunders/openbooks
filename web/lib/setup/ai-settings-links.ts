/** Keep bookmarked policy drawers and activity filters at their actual settings home. */
export function aiSettingsDestination(params: Record<string, string | string[] | undefined>): string | null {
  const tab = typeof params.tab === 'string' ? params.tab : undefined
  const settings = typeof params.row === 'string' || params.entity === 'ai-rails-settings'
  const activity = tab === 'decisions' || tab === 'activity' || typeof params.capabilityKey === 'string'
  const limits = tab === 'governance' || tab === 'capabilities'
  if (!settings && !activity && !limits) return null
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && !['tab', 'entity'].includes(key)) query.set(key, value)
  }
  if (activity) query.set('tab', 'activity')
  const suffix = query.size ? `?${query}` : ''
  return `${settings ? '/admin/setup/ai-rails-settings' : '/admin/setup/ai-capabilities'}${suffix}`
}
