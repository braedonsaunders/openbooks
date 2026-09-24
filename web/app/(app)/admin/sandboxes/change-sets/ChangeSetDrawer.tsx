"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Badge, Button, UrlDrawer } from "@openbooks/ui";
import { PagedTable, type PagedColumn } from "../../../../../components/paged-table";
import { confirmDialog } from "../../../../../lib/confirm";
import type { ChangeSetDetail, ChangeSetItem } from "../../../../../lib/sandbox-change-sets";
import { promotionNextStep } from "../../../../../lib/sandbox-promotion";
import { JsonValue } from "../../audit/AuditEventDrawer";
import { transitionChangeSetAction } from "../actions";

const STATUS_LABELS = ["draft", "reviewed", "approved", "applied", "discarded"] as const;

/**
 * Resolves a server-supplied enum to catalog copy, falling back to the raw
 * value when the server sends something the catalog does not know — a new
 * status must read raw, never crash the drawer.
 */
function pickLabel<T extends string>(value: string, options: readonly T[], resolve: (key: T) => string): string {
  return (options as readonly string[]).includes(value) ? resolve(value as T) : value;
}

export function ChangeSetDrawer({ detail, actorId }: { detail: ChangeSetDetail; actorId: string }) {
  const t = useTranslations("admin");
  const cs = "sandboxes.changeSets";
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const item = detail.items.find(row => row.id === itemId);
  const next = promotionNextStep(detail, actorId);
  const columns: PagedColumn<ChangeSetItem>[] = [
    { key: "type", header: t(`${cs}.columns.type`), cell: row => row.tableName.replaceAll("_", " "), search: row => row.tableName },
    { key: "record", header: t(`${cs}.columns.record`), cell: row => <Button variant="link" onClick={() => setItemId(row.id)}>{String(row.payload?.name ?? row.expectedBefore?.name ?? row.targetId)}</Button>,
      search: row => `${row.targetId} ${row.payload?.name ?? row.expectedBefore?.name ?? ""}` },
    { key: "operation", header: t(`${cs}.columns.change`), cell: row => <Badge variant={row.op === "delete" ? "destructive" : "secondary"}>{t(`${cs}.op.${row.op}`)}</Badge>, search: row => row.op },
  ];
  return <UrlDrawer open closeHref="/admin/sandboxes/change-sets" size="2xl" title={detail.name}
    description={detail.sandboxName ? t(`${cs}.capturedFrom`, { name: detail.sandboxName }) : t(`${cs}.retained`)}
    footer={<>
      {next.transition && <Button disabled={pending || Boolean(item)} onClick={() => start(async () => {
        const transition = next.transition!;
        if (!(await confirmDialog(t(`${cs}.confirm`, { action: t(`${cs}.actions.${transition}`), name: detail.name })))) return;
        setError(null);
        try {
          const result = await transitionChangeSetAction(detail.id, transition);
          if (result.error) setError(result.error);
          else router.refresh();
        } catch { setError(t(`${cs}.requestFailed`)); }
      })}>{pending ? t(`${cs}.working`) : t(`${cs}.actions.${next.transition}`)}</Button>}
    </>}>
    <div className="space-y-5">
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">{error}</p>}
      {item ? <>
        <Button variant="outline" onClick={() => setItemId(null)}>{t(`${cs}.backToChanges`)}</Button>
        <h2 className="text-lg font-semibold">{String(item.payload?.name ?? item.expectedBefore?.name ?? item.targetId)}</h2>
        <div className="grid gap-5 lg:grid-cols-2">
          <section className="min-w-0 space-y-2"><h3 className="font-semibold">{t(`${cs}.productionAtCapture`)}</h3>
            {!item.baseCaptured ? <p>{t(`${cs}.snapshotUnavailable`)}</p> : item.op === "insert" ? <p>{t(`${cs}.recordDidNotExist`)}</p> : <JsonValue exactNumbers value={item.expectedBefore} />}</section>
          <section className="min-w-0 space-y-2"><h3 className="font-semibold">{t(`${cs}.proposedConfiguration`)}</h3>
            {item.op === "delete" ? <p>{t(`${cs}.willBeDeleted`)}</p> : <JsonValue exactNumbers value={item.payload} />}</section>
        </div>
      </> : <>
        <Badge variant={detail.status === "applied" ? "success" : "secondary"}>{pickLabel(detail.status, STATUS_LABELS, (key) => t(`${cs}.status.${key}`))}</Badge>
        <p className="text-sm text-slate-600 dark:text-slate-400">{t(`${cs}.capturedCount`, { count: detail.itemCount })} {detail.status === "applied"
          ? t(`${cs}.appliedNote`)
          : t(`${cs}.reviewNote`)}</p>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {(["captured", "reviewed", "approved", "applied"] as const).map((stage) => {
            const entry = {
              captured: { name: detail.createdName, at: detail.createdAt },
              reviewed: { name: detail.reviewedName, at: detail.reviewedAt },
              approved: { name: detail.approvedName, at: detail.approvedAt },
              applied: { name: detail.appliedName, at: detail.appliedAt },
            }[stage];
            return <div key={stage}><dt className="font-medium">{t(`${cs}.stages.${stage}`)}</dt><dd>{entry.at ? `${entry.name ?? t(`${cs}.recordedActor`)} · ${new Date(entry.at).toLocaleString()}` : t(`${cs}.pending`)}</dd></div>;
          })}
        </dl>
        {next.reasonKey && <p role="status" className="text-sm text-amber-800 dark:text-amber-300">{t(`${cs}.reasons.${next.reasonKey}`)}</p>}
        <PagedTable rows={detail.items} columns={columns} rowKey={row => row.id} searchable empty={t(`${cs}.empty`)} />
      </>}
    </div>
  </UrlDrawer>;
}
