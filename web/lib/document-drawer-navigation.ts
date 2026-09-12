/** Keep a related transaction in its existing party, project, or report host. */
export function documentDrawerHref({ pathname, query, basePath, currentId, targetId, kind, related, form }: {
  pathname: string
  query: string
  basePath: string
  currentId: string
  targetId: string
  kind: string
  related?: boolean
  form?: string
}): string {
  const params = new URLSearchParams(query)
  if (related) {
    const host = ([
      ['partyTxn', 'partyTxnKind'],
      ['projectTxn', 'projectTxnKind'],
      ['reportRecord', 'reportRecordKind'],
    ] as const).find(([id]) => params.get(id) === currentId)
    if (host) {
      params.set(host[0], targetId)
      params.set(host[1], kind)
    } else {
      // The global report host supports every related document kind, including
      // project charges which have no standalone ?doc= list destination.
      params.set('reportRecord', targetId)
      params.set('reportRecordKind', kind)
      params.set('drawerReturn', pathname + (query ? `?${query}` : ''))
    }
  } else {
    const native = new URLSearchParams({ doc: targetId })
    if (form !== undefined) native.set('form', form)
    return `${basePath}?${native}`
  }
  params.delete('transactionTab')
  params.delete('form')
  if (form !== undefined) params.set('form', form)
  return `${pathname}?${params}`
}
