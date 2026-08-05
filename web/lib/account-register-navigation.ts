const REGISTER_KEYS = [
  'accountRegister',
  'accountRegisterPage',
  'accountRegisterFrom',
  'accountRegisterTo',
] as const

const CHILD_KEYS = [
  'reportRecord',
  'reportRecordKind',
  'txn',
  'drawerReturn',
  'form',
  'transactionTab',
] as const

function href(pathname: string, params: URLSearchParams) {
  const query = params.toString()
  return query ? `${pathname}?${query}` : pathname
}

export function accountRegisterHref(
  pathname: string,
  query: string,
  accountId: string,
  period?: { from?: string; to?: string },
) {
  const params = new URLSearchParams(query)
  params.set('accountRegister', accountId)
  params.delete('accountRegisterPage')
  if (period?.from) params.set('accountRegisterFrom', period.from)
  else params.delete('accountRegisterFrom')
  if (period?.to) params.set('accountRegisterTo', period.to)
  else params.delete('accountRegisterTo')
  for (const key of CHILD_KEYS) params.delete(key)
  return href(pathname, params)
}

export function accountRegisterCloseHref(pathname: string, query: string) {
  const params = new URLSearchParams(query)
  for (const key of REGISTER_KEYS) params.delete(key)
  for (const key of CHILD_KEYS) params.delete(key)
  return href(pathname, params)
}
