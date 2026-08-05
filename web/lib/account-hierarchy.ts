export interface AccountHierarchyNode {
  id: string
  parent_id: string | null
  name: string
  type: string
}

/**
 * Order one statement class as a parent-first tree. A parent outside the class
 * is deliberately treated as absent so cross-class imported data cannot make an
 * account disappear under the wrong financial-statement section.
 */
export function orderAccountHierarchy<T extends AccountHierarchyNode>(
  accounts: T[],
  classKey: string,
  classOf: Readonly<Record<string, string>>,
) {
  const members = accounts.filter((account) => classOf[account.type] === classKey)
  const byId = new Map(members.map((account) => [account.id, account]))
  const parentIds = new Map<string, string | null>()
  const children = new Map<string | null, T[]>()

  for (const account of members) {
    const parentId = account.parent_id && byId.has(account.parent_id) ? account.parent_id : null
    parentIds.set(account.id, parentId)
    if (!children.has(parentId)) children.set(parentId, [])
    children.get(parentId)!.push(account)
  }

  const ordered: T[] = []
  const visited = new Set<string>()
  const walk = (parentId: string | null) => {
    for (const account of children.get(parentId) ?? []) {
      if (visited.has(account.id)) continue
      visited.add(account.id)
      ordered.push(account)
      walk(account.id)
    }
  }
  walk(null)

  // A malformed imported cycle must remain visible for correction.
  for (const account of members) {
    if (!visited.has(account.id)) {
      parentIds.set(account.id, null)
      ordered.push(account)
    }
  }

  return { members, ordered, parentIds }
}

export function accountParentPath<T extends Pick<AccountHierarchyNode, 'id' | 'parent_id' | 'name'>>(
  account: T,
  byId: ReadonlyMap<string, T>,
) {
  const names: string[] = []
  const visited = new Set<string>()
  let parentId = account.parent_id
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    names.unshift(parent.name)
    parentId = parent.parent_id
  }
  return names.join(' / ')
}
