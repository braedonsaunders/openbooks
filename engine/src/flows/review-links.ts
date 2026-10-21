/** Native command requests are reviewed in the tenant's existing Inbox. */
export function approvalRequestHref(subjectKind: string, subjectId: string): string {
  return `/inbox?reviewKind=${encodeURIComponent(subjectKind)}&review=${encodeURIComponent(subjectId)}`;
}
