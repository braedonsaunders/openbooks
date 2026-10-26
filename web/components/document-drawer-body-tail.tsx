import { DistributionDialog } from "./allocations/DistributionDialog";
import { ApprovalHistory } from "./approval-history";
import type { DocumentDrawerHeaderScope } from "./document-drawer-header";

/** Distribution dialog and the view-mode approval timeline under the line grid. */
export function renderDocumentDrawerBodyTail(scope: DocumentDrawerHeaderScope) {
  const {
    splitTarget,
    rows,
    dist,
    distCoordKey,
    accounts,
    distCodings,
    setSplitTarget,
    applyDialogRule,
    applyDialogChildren,
    mode,
    isCreate,
    doc,
    afterContent,
  } = scope;
  return (
    <>
      {splitTarget !== null && rows[splitTarget] ? (
        <DistributionDialog
          key={`${splitTarget}:${rows[splitTarget]!.amount}:${rows[splitTarget]!.distributionKey}`}
          open
          lineAmount={rows[splitTarget]!.amount || "0"}
          candidates={dist.cache.get(distCoordKey(rows[splitTarget]!)) ?? []}
          candidatesFailed={dist.failed.has(distCoordKey(rows[splitTarget]!))}
          accountOptions={accounts.map((a) => ({
            value: a.id,
            label: `${a.number ?? ""} ${a.name ?? ""}`.trim(),
          }))}
          codings={distCodings}
          initialRuleKey={rows[splitTarget]!.distributionKey || null}
          onClose={() => setSplitTarget(null)}
          onApplyRule={applyDialogRule}
          onApplyChildren={applyDialogChildren}
        />
      ) : null}

      {mode === "view" && !isCreate ? (
        // The record's tenant-authored Flow approval timeline. Renders
        // nothing when no approval flow applies. Never in create mode:
        // no persisted record exists to carry a timeline yet.
        <ApprovalHistory subjectKind={String(doc.kind)} subjectId={String(doc.id)} />
      ) : null}

      {mode === "view" ? afterContent : null}
    </>
  );
}
