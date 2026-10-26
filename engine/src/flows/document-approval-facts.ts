type ApprovalFactsReader = (orgId: string, documentId: string) => Promise<Record<string, unknown>>;
const runtime = globalThis as typeof globalThis & {
  __openbooksDocumentApprovalFacts?: Map<string, ApprovalFactsReader>;
};
const readers = (runtime.__openbooksDocumentApprovalFacts ??= new Map());

/** Owning modules supply their native derived facts without duplicating financial algorithms. */
export function registerDocumentApprovalFacts(kind: string, reader: ApprovalFactsReader): void {
  readers.set(kind, reader);
}
export async function readDocumentApprovalFacts(
  kind: string,
  orgId: string,
  documentId: string,
): Promise<Record<string, unknown>> {
  const reader = readers.get(kind);
  if (!reader)
    throw new Error(
      `Native ${kind} approval facts are unavailable. Retry after application initialization.`,
    );
  return reader(orgId, documentId);
}
