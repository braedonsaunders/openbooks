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
 * people and misplaced Sales destinations move together; editor moves are explicit.
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
        const index = operations.items.findIndex((item) => item.kind === 'module' && item.moduleKey === key && item.placement !== 'custom' && (!item.label || item.label === MODULE_BY_KEY.get(key)?.label || (key === 'payroll' && item.label === 'Payroll')) && !item.iconKey)
        if (index < 0) continue
        const [item] = operations.items.splice(index, 1)
        ensureGroup(key === 'me' ? 'my-work' : 'hrm').items.push(item!)
      }
    }
  }
  // Correct inherited Sales placements while retaining deliberate company moves
  // and each destination's labels, visibility, mobile pinning and relative order.
  const accounting = groups.find((group) => group.id === 'accounting' && group.label === 'Accounting')
  if (accounting) {
    const sales = accounting.items.filter((item) => item.kind === 'module' && item.placement !== 'custom' && MODULE_BY_KEY.get(item.moduleKey)?.subgroup === 'crm-sales' && MODULE_BY_KEY.get(item.moduleKey)?.group === 'customers')
    if (sales.length) {
      accounting.items = accounting.items.filter((item) => !sales.includes(item))
      ensureGroup('customers').items.push(...sales)
    }
  }
  const present = new Set(groups.flatMap((group) => group.items.flatMap((item) => item.kind === 'module' ? [item.moduleKey] : [])))
  for (const module of NAV_MODULES) {
    if (!present.has(module.key)) ensureGroup(module.group).items.push({ kind: 'module', moduleKey: module.key })
  }
  // Inherited Pre-billing belongs at the start of the customer billing
  // workflow. Explicit editor placements and every other item's order survive.
  for (const group of groups) {
    if (group.id !== 'operations' && group.id !== 'customers') continue
    const index = group.items.findIndex((item) => item.kind === 'module' && item.moduleKey === 'pre-billing' && item.placement !== 'custom')
    if (index < 0) continue
    const [item] = group.items.splice(index, 1)
    const customers = ensureGroup('customers')
    const firstBilling = customers.items.findIndex((candidate) => candidate.kind === 'module' && MODULE_BY_KEY.get(candidate.moduleKey)?.subgroup === 'sell-collect')
    customers.items.splice(firstBilling < 0 ? customers.items.length : firstBilling, 0, item!)
  }
  for (const group of groups) {
    if (!addedGroups.has(group.id)) continue
    const order = defaults.groups.find((candidate) => candidate.id === group.id)!.items
      .flatMap((item) => item.kind === 'module' ? [item.moduleKey] : [])
    group.items.sort((a, b) => a.kind === 'module' && b.kind === 'module' ? order.indexOf(a.moduleKey) - order.indexOf(b.moduleKey) : 0)
  }
  // The inherited Payroll workflow starts at its overview. Only its own
  // slots change; unrelated destinations and explicit editor placements stay put.
  const payrollOrder = ['payroll', 'payroll-runs', 'payroll-anomalies', 'payroll-remittances', 'payroll-separations']
  const people = groups.find((group) => group.id === 'hrm')
  if (people) {
    const inherited = people.items.filter((item) => item.kind === 'module' && item.placement !== 'custom' && payrollOrder.includes(item.moduleKey))
    inherited.sort((a, b) => payrollOrder.indexOf(a.kind === 'module' ? a.moduleKey : '') - payrollOrder.indexOf(b.kind === 'module' ? b.moduleKey : ''))
    let next = 0
    people.items = people.items.map((item) => inherited.includes(item) ? inherited[next++]! : item)
    const overview = people.items.find((item) => item.kind === 'module' && item.moduleKey === 'payroll')
    if (overview?.kind === 'module' && overview.label === 'Payroll') delete overview.label
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
