/**
 * Name for a newly added app action ("endpoint"): the first free `action-N`,
 * counting from 1 and skipping names already declared — including the
 * starter's sample endpoint — so the first action a person adds is always
 * `action-1` regardless of what the package already ships.
 */
export function nextActionName(existing: readonly { name: string }[]): string {
  const taken = new Set(existing.map((endpoint) => endpoint.name));
  for (let n = 1; ; n++) {
    const candidate = `action-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
