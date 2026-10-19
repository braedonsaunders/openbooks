import type { FlowSubjectContext } from './types.ts'

/** Separation-of-duties identities for a subject: submitter and maker. */
export function sodBlockedIds(
  subject: Pick<FlowSubjectContext, 'submitterUserId' | 'makerUserId'> | null,
): ReadonlySet<string> {
  const ids = new Set<string>()
  if (subject?.submitterUserId) ids.add(subject.submitterUserId)
  if (subject?.makerUserId) ids.add(subject.makerUserId)
  return ids
}
