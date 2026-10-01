import { MODULE_BY_KEY, NAV_GROUP_BY_KEY, NAV_MODULES, defaultNavConfig, type NavGroupConfig, type NavGroupKey, type NavItemConfig, type OrgNavConfig } from './nav-registry.ts'

/** Local detail views stay out of their default menu section. Explicit moves
 * and promotions retain the company's shortcut without changing local tabs. */
export function isDefaultLocalNavigationItem(groupId: string, item: NavItemConfig): boolean {
  if (item.kind !== 'module') return false
  const module = MODULE_BY_KEY.get(item.moduleKey)
  return !!module?.menuParent && groupId === module.group && item.placement !== 'custom'
}

/**
 * Reconcile shipped destinations without replacing company-defined groups,
 * labels, visibility, shortcuts, or deliberate placements. Legacy default
 * people destinations move together; subsequent editor moves are explicit.
 */
export function reconcileNavConfig(saved: OrgNavConfig): OrgNavConfig {
  const groups = saved.groups.map((group) => ({ ...group, items: group.items.map((item) => ({ ...item })) }))
  const addedGroups = new Set<string>()
  const defaults = defaultNavConfig()
  const ensureGroup = (id: NavGroupKey): NavGroupConfig => {
    let group = groups.find((candidate) => candidate.id === id)
    if (!group) {
      const definition = NAV_GROUP_BY_KEY.get(id)!
      addedGroups.add(id)
      group = { id, label: definition.label, items: [] }
      const defaultIndex = defaults.groups.findIndex((candidate) => candidate.id === id)
      const following = defaults.groups.slice(defaultIndex + 1).find((candidate) => groups.some((existing) => existing.id === candidate.id))
      const index = following ? groups.findIndex((candidate) => candidate.id === following.id) : groups.length
      groups.splice(index, 0, group)
    }
    return group
  }
  if (!saved.architectureVersion) {
    const operations = groups.find((group) => group.id === 'operations' && group.label === 'Operations')
    if (operations) {
      for (const key of ['employees', 'payroll', 'hrm', 'me']) {
        const index = operations.items.findIndex((item) => item.kind === 'module' && item.moduleKey === key && item.placement !== 'custom' && (!item.label || item.label === MODULE_BY_KEY.get(key)?.label) && !item.iconKey)
        if (index < 0) continue
        const [item] = operations.items.splice(index, 1)
        ensureGroup(key === 'me' ? 'my-work' : 'hrm').items.push(item!)
      }
    }
  }
  const present = new Set(groups.flatMap((group) => group.items.flatMap((item) => item.kind === 'module' ? [item.moduleKey] : [])))
  for (const module of NAV_MODULES) {
    if (!present.has(module.key)) ensureGroup(module.group).items.push({ kind: 'module', moduleKey: module.key })
  }
  for (const group of groups) {
    if (!addedGroups.has(group.id)) continue
    const order = defaults.groups.find((candidate) => candidate.id === group.id)!.items
      .flatMap((item) => item.kind === 'module' ? [item.moduleKey] : [])
    group.items.sort((a, b) => a.kind === 'module' && b.kind === 'module' ? order.indexOf(a.moduleKey) - order.indexOf(b.moduleKey) : 0)
  }
  return { ...saved, architectureVersion: 1, groups }
}

/** HR ownership is presentation, not a new dependency between HR and Payroll. */
export function featureAwareNavConfig(config: OrgNavConfig, hrmEnabled: boolean): OrgNavConfig {
  if (hrmEnabled) return config
  const groups = config.groups.map((group) => ({ ...group, items: [...group.items] }))
  const hrm = groups.find((group) => group.id === 'hrm')
  if (!hrm) return { ...config, groups }
  const fallback = hrm.items.filter((item) => item.kind === 'module' && (item.moduleKey === 'employees' || MODULE_BY_KEY.get(item.moduleKey)?.featureKey === 'payroll'))
  if (!fallback.length) return { ...config, groups }
  hrm.items = hrm.items.filter((item) => !fallback.includes(item))
  let operations = groups.find((group) => group.id === 'operations')
  if (!operations) {
    operations = { id: 'operations', label: 'Operations', items: [] }
    groups.push(operations)
  }
  operations.items.push(...fallback)
  return { ...config, groups }
}
