type Catalog = { (key: string): string; has(key: string): boolean }
type Resource = { key: string; label: string; group: string }

/** Built-in names share the Setup and record catalogs; custom names stay authoritative. */
export function dataResourceLabel(item: Resource, catalog: Catalog): string {
  const key = item.group === 'Setup' ? `admin.setup.entities.${item.key}.title`
    : item.group === 'Master data' ? (item.key === 'parties' ? 'data.resources.parties' : `nav.modules.${item.key}`)
    : item.group === 'Transactions' ? (item.key === 'txn:pay_run' ? 'nav.modules.payroll-runs' : `common.transactionTypes.${item.key.replace(/^txn:/, '').replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())}`)
    : ''
  return key && catalog.has(key) ? catalog(key) : item.label
}

export function dataFieldLabel(field: { key: string; label: string }, resource: { key: string; group: string } | undefined, catalog: Catalog): string {
  if (field.label !== field.key) return field.label
  const namespace = resource?.group === 'Setup' || resource?.key === 'accounts' ? 'admin.setup.fields'
    : resource?.key === 'parties' ? 'parties.drawer'
    : resource?.key === 'items' ? 'items.labels' : ''
  const key = namespace && `${namespace}.${field.key}`
  if (key && catalog.has(key)) return catalog(key)
  const commonKey = `common.labels.${field.key === 'isActive' ? 'active' : field.key}`
  return catalog.has(commonKey) ? catalog(commonKey) : field.label
}
