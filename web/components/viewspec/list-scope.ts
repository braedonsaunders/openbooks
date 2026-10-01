import { ROOT_SCOPE_KEY } from '@braedonsaunders/appkit-viewspec'

export function rootOf(scope: unknown): unknown {
  if (scope !== null && typeof scope === 'object' && ROOT_SCOPE_KEY in scope) {
    return (scope as Record<string, unknown>)[ROOT_SCOPE_KEY]
  }
  return scope
}

export function nestedScope(item: unknown, scope: unknown): unknown {
  if (item === null || typeof item !== 'object') return item
  return { ...item, [ROOT_SCOPE_KEY]: rootOf(scope) }
}
