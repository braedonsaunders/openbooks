"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, UrlDrawer } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "../../../../../components/paged-table";
import { confirmDialog } from "../../../../../lib/confirm";
import type { ChangeSetDetail, ChangeSetItem } from "../../../../../lib/sandbox-change-sets";
import { promotionNextStep } from "../../../../../lib/sandbox-promotion";
import { JsonValue } from "../../audit/AuditEventDrawer";
import { transitionChangeSetAction } from "../actions";

export function ChangeSetDrawer({ detail, actorId }: { detail: ChangeSetDetail; actorId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const item = detail.items.find(row => row.id === itemId);
  const next = promotionNextStep(detail, actorId);
  const labels = { review: "Record review", approve: "Approve change set", apply: "Apply to production" };
  const columns: PagedColumn<ChangeSetItem>[] = [
    { key: "type", header: "Record type", cell: row => row.tableName.replaceAll("_", " "), search: row => row.tableName },
    { key: "record", header: "Record", cell: row => <Button variant="link" onClick={() => setItemId(row.id)}>{String(row.payload?.name ?? row.expectedBefore?.name ?? row.targetId)}</Button>,
      search: row => `${row.targetId} ${row.payload?.name ?? row.expectedBefore?.name ?? ""}` },
    { key: "operation", header: "Change", cell: row => <Badge variant={row.op === "delete" ? "destructive" : "secondary"}>{row.op}</Badge>, search: row => row.op },
  ];
  return <UrlDrawer open closeHref="/admin/sandboxes/change-sets" size="2xl" title={detail.name}
    description={detail.sandboxName ? `Captured from ${detail.sandboxName}` : "Retained configuration change set"}
    footer={<>
      {next.transition && <Button disabled={pending || Boolean(item)} onClick={() => start(async () => {
        const transition = next.transition!;
        if (!(await confirmDialog(`${labels[transition]} for “${detail.name}”?`))) return;
        setError(null);
        try {
          const result = await transitionChangeSetAction(detail.id, transition);
          if (result.error) setError(result.error);
          else router.refresh();
        } catch { setError("The request did not complete. Refresh to check the recorded status before trying again."); }
      })}>{pending ? "Working…" : labels[next.transition]}</Button>}
    </>}>
    <div className="space-y-5">
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {item ? <>
        <Button variant="outline" onClick={() => setItemId(null)}>Back to captured changes</Button>
        <h2 className="text-lg font-semibold">{String(item.payload?.name ?? item.expectedBefore?.name ?? item.targetId)}</h2>
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="min-w-0 space-y-2"><h3 className="font-semibold">Production at capture</h3>
            {!item.baseCaptured ? <p>Production snapshot unavailable. Recapture this change set.</p> : item.op === "insert" ? <p>Record did not exist.</p> : <JsonValue exactNumbers value={item.expectedBefore} />}</section>
          <section className="min-w-0 space-y-2"><h3 className="font-semibold">Proposed configuration</h3>
            {item.op === "delete" ? <p>This record will be deleted.</p> : <JsonValue exactNumbers value={item.payload} />}</section>
        </div>
      </> : <>
        <Badge variant={detail.status === "applied" ? "success" : "secondary"}>{detail.status}</Badge>
        <p className="text-sm text-slate-600 dark:text-slate-400">{detail.itemCount} captured {detail.itemCount === 1 ? "change" : "changes"}. {detail.status === "applied"
          ? "Configuration applied. The captured evidence remains available below."
          : "Inspect each record before recording your review or approval. Production changes made after capture will prevent application."}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {[["Captured", detail.createdName, detail.createdAt], ["Reviewed", detail.reviewedName, detail.reviewedAt],
            ["Approved", detail.approvedName, detail.approvedAt], ["Applied", detail.appliedName, detail.appliedAt]].map(([label, name, at]) =>
            <div key={label}><dt className="font-medium">{label}</dt><dd>{at ? `${name ?? "Recorded actor"} · ${new Date(at).toLocaleString()}` : "Pending"}</dd></div>)}
        </dl>
        {next.reason && <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{next.reason}</p>}
        <PagedTable rows={detail.items} columns={columns} rowKey={row => row.id} searchable empty="No configuration changes." />
      </>}
    </div>
  </UrlDrawer>;
}
