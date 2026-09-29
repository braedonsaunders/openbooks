import { defaultNavConfig, type OrgNavConfig, type NavItemConfig } from './registry'

/** Front-load daily work; keep enabled specialist modules in their native groups. */
export function essentialsNavConfig(): OrgNavConfig {
  const config = defaultNavConfig()
  const everyday = ['dashboard', 'ar-invoices', 'ap-bills', 'receipts', 'payments', 'expenses', 'banking-match', 'reports', 'approvals']
  const moved = new Set(everyday)
  // Module landing pages remain reachable from the native group headers.
  const landing = new Set(['ar', 'ap', 'banking'])
  const items = new Map<string, NavItemConfig>()
  for (const group of config.groups) {
    for (const item of group.items) if (item.kind === 'module') items.set(item.moduleKey, item)
    group.items = group.items.filter((item) => item.kind !== 'module' || (!moved.has(item.moduleKey) && !landing.has(item.moduleKey)))
  }
  const home = config.groups.find((group) => group.id === 'my-work')!
  home.items.unshift(...everyday.flatMap((key) => items.has(key)
    ? [{ ...items.get(key)!, ...(['ar-invoices', 'ap-bills'].includes(key) ? { mobile: true } : {}) }]
    : []))
  return config
}
