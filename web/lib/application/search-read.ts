import "server-only";
import { clamp } from "../list-params";
import { globalSearch } from "../search";
import type { ApplicationContext } from "./context";
import { invalidInput } from "./errors";

/** Global search — same reader as the header search bar (`globalSearch`). */
export async function searchApplication(
  context: ApplicationContext,
  input: { q: string; limit?: number },
) {
  const q = (input.q ?? "").trim();
  if (!q) {
    throw invalidInput("q is required");
  }
  // The finder scopes every entity by the caller's own permissions,
  // subsidiary visibility, and feature gates. Pass the context authz through
  // untouched and let its refusals propagate — never swallow them into [].
  const result = await globalSearch(context.authz, q);
  // `limit` caps total hits across groups, preserving the finder's group
  // order. The finder itself has no limit parameter, so trim here.
  const limit = clamp(input.limit ?? 20, 1, 50);
  if (result.total <= limit) return result;
  let remaining = limit;
  const groups = [];
  for (const group of result.groups) {
    if (remaining <= 0) break;
    const hits = group.hits.slice(0, remaining);
    remaining -= hits.length;
    if (hits.length > 0) groups.push({ ...group, hits });
  }
  return { q: result.q, groups, total: limit };
}
