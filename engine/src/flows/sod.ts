import type { FlowSubjectContext } from "./types.ts";

/** Separation-of-duties identities for a subject: submitter and maker. */
export function sodBlockedIds(
  subject: Pick<FlowSubjectContext, "submitterUserId" | "makerUserId" | "makerUserIds"> | null,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (subject?.submitterUserId) ids.add(subject.submitterUserId);
  if (subject?.makerUserId) ids.add(subject.makerUserId);
  for (const id of subject?.makerUserIds ?? []) if (id) ids.add(id);
  return ids;
}
