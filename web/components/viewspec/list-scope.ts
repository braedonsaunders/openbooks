import { ROOT_SCOPE_KEY } from "@braedonsaunders/appkit-viewspec";

export function rootOf(scope: unknown): unknown {
  if (scope !== null && typeof scope === "object" && ROOT_SCOPE_KEY in scope) {
    return (scope as Record<string, unknown>)[ROOT_SCOPE_KEY];
  }
  return scope;
}

/**
 * The page scope, for `$root` resolution.
 *
 * `$root` always means the PAGE, at any nesting depth. Each nesting level
 * therefore PRESERVES an existing `$root` instead of pointing it at itself —
 * otherwise a table inside a repeat would shadow it and `$root.someLabel`
 * would silently resolve to nothing, rendering an empty cell that looks fine
 * until the DOM is diffed. That happened twice before this existed.
 */
export function nestedScope(item: unknown, scope: unknown): unknown {
  if (item === null || typeof item !== "object") return item;
  return { ...item, [ROOT_SCOPE_KEY]: rootOf(scope) };
}
