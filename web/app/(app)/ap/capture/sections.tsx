"use client";

import { PagedTable } from "../../../../components/paged-table";
import { useRef, useState, type RefObject } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { Copy, FileSearch, Loader2, Mail, UserCheck } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, EmptyState } from "@openbooks/ui";
import { mergeHref } from "../../../../lib/list-params";
import { SortTh } from "../../../../components/sortable-th";
import { chunkArray, readApiErrorMessage, reconcileBulkResults } from "../../../../lib/api-error";
import { promptDialog } from "../../../../lib/prompt";
import { CaptureUploadButton } from "./CaptureUploadButton";
import { useShortcuts } from "../../../../components/shortcuts/shortcut-provider";

export type CaptureListRow = {
  id: string;
  status: string;
  filename: string;
  documentKind: string;
  vendorName: string | null;
  resolvedVendor: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string | null;
  total: string | null;
  overallConfidence: string | null;
  validationIssues: Array<{ severity?: string }>;
  documentId: string | null;
  receivedAt: string;
  source?: string;
};

/** An active inbound address shown above the queue, with what to copy. */
export type CaptureMailbox = {
  id: string;
  label: string;
  entity: string;
  emailAddress: string | null;
  /** Carries the address token; present only for administrators who manage addresses. */
  webhookUrl: string | null;
  ownerName: string | null;
  /** The owner can still receive bills (active, may create bills, can access the entity). */
  ownerReady: boolean;
  canTakeOwnership: boolean;
};

/**
 * The addresses bills can be emailed to, one line each, with the owner bills
 * are attributed to and copy buttons: the forwarding address for vendors
 * and, for administrators, the webhook URL for the email provider. Shown
 * above the queue so a clerk can hand an address out without leaving the
 * page; an address whose owner can no longer receive bills is flagged, and
 * an administrator can take ownership of it here.
 */
function MailboxStrip({
  mailboxes,
  manageHref,
}: {
  mailboxes: CaptureMailbox[];
  manageHref: string | null;
}) {
  const t = useTranslations("apInbox.mailboxes");
  const router = useRouter();
  const [taking, setTaking] = useState<string | null>(null);
  if (mailboxes.length === 0 && !manageHref) return null;
  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  }
  async function takeOwnership(mailbox: CaptureMailbox) {
    const reason = await promptDialog({
      title: t("takeOwnershipTitle", { label: mailbox.label }),
      message: t("takeOwnershipMessage"),
      label: t("takeOwnershipReason"),
      multiline: true,
      confirmLabel: t("takeOwnership"),
    });
    if (!reason) return;
    setTaking(mailbox.id);
    try {
      const response = await fetch(`/api/ap-capture/mailboxes/${mailbox.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ takeOwnership: true, reason }),
      });
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, t("takeOwnershipFailed")));
        return;
      }
      toast.success(t("ownershipTaken"));
      router.refresh();
    } catch {
      toast.error(t("takeOwnershipFailed"));
    } finally {
      setTaking(null);
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900/60">
      <span className="flex items-center gap-1.5 font-medium text-slate-700 dark:text-slate-200">
        <Mail size={14} />
        {t("title")}
      </span>
      {mailboxes.map((mailbox) => (
        <span key={mailbox.id} className="flex items-center gap-1.5">
          <span className="text-slate-500 dark:text-slate-400">
            {mailbox.label} · {mailbox.entity}
          </span>
          {mailbox.emailAddress ? (
            <>
              <span className="font-mono text-xs">{mailbox.emailAddress}</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-6 w-6"
                aria-label={t("copyAddress", { label: mailbox.label })}
                title={t("copyAddress", { label: mailbox.label })}
                onClick={() => void copy(mailbox.emailAddress!)}
              >
                <Copy size={12} />
              </Button>
            </>
          ) : null}
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {t("owner", { name: mailbox.ownerName ?? "—" })}
          </span>
          {mailbox.ownerReady ? null : (
            <Badge variant="warning" title={t("ownerProblemHint")}>
              {t("ownerProblem")}
            </Badge>
          )}
          {mailbox.webhookUrl ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-xs"
              aria-label={t("copyWebhook", { label: mailbox.label })}
              onClick={() => void copy(mailbox.webhookUrl!)}
            >
              <Copy size={12} />
              {t("webhook")}
            </Button>
          ) : null}
          {mailbox.canTakeOwnership ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-xs"
              disabled={taking !== null}
              aria-label={t("takeOwnershipAria", { label: mailbox.label })}
              onClick={() => void takeOwnership(mailbox)}
            >
              {taking === mailbox.id ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <UserCheck size={12} />
              )}
              {t("takeOwnership")}
            </Button>
          ) : null}
        </span>
      ))}
      {mailboxes.length === 0 ? (
        <span className="text-slate-500 dark:text-slate-400">{t("none")}</span>
      ) : null}
      {manageHref ? (
        <Link
          href={manageHref as never}
          className="ml-auto text-xs font-medium text-teal-700 hover:underline dark:text-teal-300"
        >
          {t("manage")}
        </Link>
      ) : null}
    </div>
  );
}

/**
 * J / K move the keyboard cursor through the queue's document links in list
 * order; Enter on the focused link opens its review drawer. While the drawer
 * is open its own J / K take over (form scope wins over page scope).
 */
function useRowCursor(container: RefObject<HTMLDivElement | null>) {
  const t = useTranslations("apInbox.keyboard");
  function move(step: 1 | -1) {
    const links = [
      ...(container.current?.querySelectorAll<HTMLAnchorElement>("[data-capture-row-link]") ?? []),
    ];
    if (!links.length) return;
    const current = links.findIndex((link) => link === document.activeElement);
    const next =
      current < 0
        ? step === 1
          ? 0
          : links.length - 1
        : Math.min(links.length - 1, Math.max(0, current + step));
    links[next]!.focus();
    links[next]!.scrollIntoView?.({ block: "nearest" });
  }
  useShortcuts([
    {
      id: "apCaptureListNext",
      label: () => t("listNext"),
      binding: { character: "j" },
      scope: "page",
      container: () => container.current,
      run: () => move(1),
    },
    {
      id: "apCaptureListPrevious",
      label: () => t("listPrevious"),
      binding: { character: "k" },
      scope: "page",
      container: () => container.current,
      run: () => move(-1),
    },
  ]);
}

const VARIANT: Record<string, "success" | "warning" | "destructive" | "outline" | "secondary"> = {
  ready: "success",
  materialized: "success",
  needs_review: "warning",
  duplicate: "warning",
  failed: "destructive",
  extracting: "secondary",
  queued: "secondary",
  rejected: "outline",
};

/** Capture actions operate only on the selectable records in this server
 * window. The registered shared table must not re-page or filter that window;
 * bulk results and their named refusals remain visible beside the controls. */
export function CaptureList({
  rows,
  mailboxes = [],
  manageMailboxesHref = null,
  currentParams,
  canCreate,
  uploadDisabled,
  sort,
  dir,
}: {
  rows: CaptureListRow[];
  mailboxes?: CaptureMailbox[];
  manageMailboxesHref?: string | null;
  currentParams: Record<string, string | string[] | undefined>;
  canCreate: boolean;
  uploadDisabled: boolean;
  sort: string;
  dir: "asc" | "desc";
}) {
  const t = useTranslations("ap.capture");
  const tInbox = useTranslations("apInbox");
  const listRef = useRef<HTMLDivElement | null>(null);
  useRowCursor(listRef);
  const locale = useLocale();
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const selectable = rows.filter((row) => row.status !== "materialized");

  const [bulkResult, setBulkResult] = useState<{
    succeeded: number;
    failures: Array<{ id: string; name: string; error: string }>;
  } | null>(null);
  const names = new Map(rows.map((row) => [row.id, row.filename] as const));

  // One request per bounded batch: the route refuses batches over its
  // per-request ceiling by name (see BULK_ACTION_MAX_IDS in
  // web/app/api/ap-capture/actions), so a 100-row selection goes as
  // bounded batches and every selected id is attempted.
  const BULK_BATCH_SIZE = 50;

  async function act(action: "reprocess" | "reject" | "materialize") {
    if (!selected.size) return;
    setBusy(true);
    setBulkResult(null);
    try {
      const ids = [...selected];
      const aggregated: Array<{
        id: string;
        ok: boolean;
        error?: string;
        errorCode?: string;
        details?: { line?: unknown };
      }> = [];
      // A failed or lost chunk must not discard the confirmed verdicts of
      // completed chunks: this chunk's ids are marked unknown (kept
      // selected, with the named outcome) instead of replaying blindly.
      const unknownReasons = new Map<string, string>();
      for (const chunk of chunkArray(ids, BULK_BATCH_SIZE)) {
        try {
          const response = await fetch("/api/ap-capture/actions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, ids: chunk }),
          });
          // The status is checked before the body parses: a non-JSON 502
          // page must name the translated fallback, never a SyntaxError.
          if (!response.ok) throw new Error(await readApiErrorMessage(response, t("actionFailed")));
          const body = (await response.json()) as {
            results?: Array<{
              id: string;
              ok: boolean;
              error?: string;
              errorCode?: string;
              details?: { line?: unknown };
            }>;
          };
          aggregated.push(...(body.results ?? []));
        } catch (e) {
          const reason = e instanceof Error ? e.message : t("actionFailed");
          for (const id of chunk) unknownReasons.set(id, reason);
        }
      }
      // Every requested id gets exactly one verdict: a partial bulk result
      // names its reasons per item instead of collapsing them to counts;
      // an id the server never answered stays selected flagged "not
      // processed"; an id from a failed or lost chunk stays selected
      // flagged "unknown" — never a phantom success, never a blind replay.
      const knownIds = ids.filter((id) => !unknownReasons.has(id));
      const failed = reconcileBulkResults(knownIds, aggregated, t("notProcessed"));
      const resultsById = new Map(aggregated.map((result) => [result.id, result] as const));
      for (const failure of failed) {
        const result = resultsById.get(failure.id);
        if (result?.errorCode === "purchase_order_unresolved")
          failure.error = t("issues.purchase_order_unresolved");
        if (result?.errorCode === "po_line_unmatched")
          failure.error = t("issues.po_line_unmatched", {
            line: typeof result.details?.line === "number" ? result.details.line : 1,
          });
      }
      for (const [id, reason] of unknownReasons) {
        failed.push({ id, error: t("bulkUnknown", { reason }) });
      }
      const succeeded = ids.length - failed.length;
      if (failed.length > 0) {
        setBulkResult({
          succeeded,
          failures: failed.map((item) => ({
            ...item,
            name: names.get(item.id) ?? item.id,
          })),
        });
        setSelected(new Set(failed.map((item) => item.id)));
        toast.error(t("bulkPartial", { succeeded, failed: failed.length }));
      } else {
        toast.success(t("bulkComplete", { succeeded, failed: 0 }));
        setSelected(new Set());
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  // The empty queue names its setup route: creators who can upload get the
  // upload action inline; while capture is not operational the amber banner
  // above already carries the AI setup link; readers without creation access
  // hear the grant instead of an action they cannot take.
  if (!rows.length) {
    return (
      <div className="space-y-2">
        <MailboxStrip mailboxes={mailboxes} manageHref={manageMailboxesHref} />
        <EmptyState
          icon={<FileSearch />}
          title={t("emptyTitle")}
          description={canCreate ? t("emptyDescription") : t("emptyDescriptionNoGrant")}
          action={canCreate && !uploadDisabled ? <CaptureUploadButton /> : undefined}
        />
      </div>
    );
  }
  return (
    <div className="space-y-2" ref={listRef}>
      <MailboxStrip mailboxes={mailboxes} manageHref={manageMailboxesHref} />
      {canCreate ? (
        <div className="flex min-h-9 flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={selectable.length > 0 && selectable.every((row) => selected.has(row.id))}
              onChange={(event) =>
                setSelected(
                  event.target.checked ? new Set(selectable.map((row) => row.id)) : new Set(),
                )
              }
              className="h-4 w-4 rounded border-slate-300 text-teal-600"
            />
            {t("selected", { count: selected.size })}
          </label>
          {selected.size ? (
            <>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act("reprocess")}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : null}
                {t("reprocess")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => void act("reject")}
              >
                {t("reject")}
              </Button>
              <Button size="sm" disabled={busy} onClick={() => void act("materialize")}>
                {t("createDrafts")}
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
      {bulkResult && bulkResult.failures.length > 0 ? (
        <div
          role="alert"
          className="space-y-1 rounded-lg border border-red-200 bg-red-50 p-3 text-sm dark:border-red-900/60 dark:bg-red-950/40"
        >
          <p className="font-medium text-red-800 dark:text-red-200">
            {t("bulkPartial", {
              succeeded: bulkResult.succeeded,
              failed: bulkResult.failures.length,
            })}
          </p>
          <ul className="list-disc space-y-0.5 pl-5 text-red-700 dark:text-red-300">
            {bulkResult.failures.map((item) => (
              <li key={item.id}>
                <span className="font-medium">{item.name}</span>
                {" — "}
                {item.error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <PagedTable
        source="ap_capture"
        rows={rows}
        rowKey={(row) => row.id}
        empty=""
        columns={[
          ...(canCreate
            ? [
                {
                  key: "column_0",
                  header: (
                    <>
                      <span className="sr-only">{t("select")}</span>
                    </>
                  ),
                  headerClassName: "w-10",
                  cell: (row: CaptureListRow) => (
                    <>
                      <input
                        type="checkbox"
                        disabled={row.status === "materialized"}
                        checked={selected.has(row.id)}
                        onChange={(event) =>
                          setSelected((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.id);
                            else next.delete(row.id);
                            return next;
                          })
                        }
                        aria-label={t("selectDocument", { name: row.filename })}
                        className="h-4 w-4 rounded border-slate-300 text-teal-600"
                      />
                    </>
                  ),
                  search: (row: CaptureListRow) =>
                    Object.values(row)
                      .filter((value) => typeof value === "string" || typeof value === "number")
                      .join(" "),
                },
              ]
            : []),
          {
            key: "column_1",
            header: <>{t("columns.document")}</>,
            headerCell: (
              <SortTh
                basePath="/ap/capture"
                currentParams={currentParams}
                column="filename"
                sort={sort}
                dir={dir}
              >
                {t("columns.document")}
              </SortTh>
            ),
            cell: (row: CaptureListRow) => (
              <>
                <Link
                  href={mergeHref("/ap/capture", currentParams, {
                    capture: row.id,
                  })}
                  data-capture-row-link=""
                  className="rounded font-medium text-teal-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 dark:text-teal-300"
                >
                  {row.filename}
                </Link>
                <div className="text-xs text-slate-400">
                  {row.documentKind === "vendor_credit" ? t("credit") : t("bill")}
                  {row.source === "email" ? ` · ${tInbox("emailSource")}` : null}
                </div>
              </>
            ),
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
          {
            key: "column_2",
            header: <>{t("columns.vendor")}</>,
            cell: (row: CaptureListRow) => <>{row.resolvedVendor ?? row.vendorName ?? "—"}</>,
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
          {
            key: "column_3",
            header: <>{t("columns.invoice")}</>,
            cell: (row: CaptureListRow) => <>{row.invoiceNumber ?? "—"}</>,
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
          {
            key: "column_4",
            header: <>{t("columns.date")}</>,
            cell: (row: CaptureListRow) => <>{row.invoiceDate ?? "—"}</>,
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
          {
            key: "column_5",
            header: <>{t("columns.total")}</>,
            headerCell: (
              <SortTh
                basePath="/ap/capture"
                currentParams={currentParams}
                column="total"
                sort={sort}
                dir={dir}
                align="right"
                className="text-right"
              >
                {t("columns.total")}
              </SortTh>
            ),
            headerClassName: "text-right",
            className: "text-right tabular-nums",
            cell: (row: CaptureListRow) => (
              <>{row.total ? `${row.currency ?? ""} ${row.total}`.trim() : "—"}</>
            ),
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
          {
            key: "column_6",
            header: <>{t("columns.status")}</>,
            headerCell: (
              <SortTh
                basePath="/ap/capture"
                currentParams={currentParams}
                column="status"
                sort={sort}
                dir={dir}
              >
                {t("columns.status")}
              </SortTh>
            ),
            cell: (row: CaptureListRow) => {
              const issues = Array.isArray(row.validationIssues)
                ? row.validationIssues.filter((value) => value.severity === "blocking").length
                : 0;
              return (
                <>
                  <div className="flex items-center gap-1.5">
                    <Badge variant={VARIANT[row.status] ?? "outline"}>
                      {t(`status.${row.status}`)}
                    </Badge>
                    {issues ? <Badge variant="destructive">{issues}</Badge> : null}
                  </div>
                </>
              );
            },
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
          {
            key: "column_7",
            header: <>{t("columns.received")}</>,
            headerCell: (
              <SortTh
                basePath="/ap/capture"
                currentParams={currentParams}
                column="received"
                sort={sort}
                dir={dir}
              >
                {t("columns.received")}
              </SortTh>
            ),
            className: "whitespace-nowrap text-xs text-slate-500",
            cell: (row: CaptureListRow) => (
              <>
                {new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(row.receivedAt))}
              </>
            ),
            search: (row: CaptureListRow) =>
              Object.values(row)
                .filter((value) => typeof value === "string" || typeof value === "number")
                .join(" "),
          },
        ]}
      />
    </div>
  );
}
