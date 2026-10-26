export type ProposalMergeScope = {
  currency: string | null | undefined;
  subsidiaryId: string | null | undefined;
};

export type ProposalMergeScopeIssue = "currency" | "missing_scope" | "subsidiary";

export function proposalMergeScopeIssue(
  rows: readonly ProposalMergeScope[],
): ProposalMergeScopeIssue | null {
  const first = rows[0];
  if (
    !first?.currency ||
    !first.subsidiaryId ||
    rows.some((row) => !row.currency || !row.subsidiaryId)
  ) {
    return "missing_scope";
  }
  if (rows.some((row) => row.subsidiaryId !== first.subsidiaryId)) return "subsidiary";
  if (rows.some((row) => row.currency !== first.currency)) return "currency";
  return null;
}

export function canMergeProposalScopes(rows: readonly ProposalMergeScope[]): boolean {
  return rows.length >= 2 && proposalMergeScopeIssue(rows) === null;
}
