/** Invoice-reference identity shared by interactive entry, imports and duplicate probes. */
export function normalizeDocumentReference(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return normalized === "" ? null : normalized;
}
