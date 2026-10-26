"use client";

import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Table, TableBody, TableHead, TableHeader, TableRow, cn } from "@openbooks/ui";
import { fetchAppAction } from "../lib/api-error";
import { confirmDialog } from "../lib/confirm";
import { useShortcuts } from "./shortcuts/shortcut-provider";

export interface BulkListRow {
  id: string;
  /** Display number used in results ("BILL-00042"). */
  number: string;
  status: string;
  /** Server-rendered cells for the row, in column order. */
  cells: ReactNode;
}

/** What the reader may do to the selected rows; the server re-checks each one. */
export interface BulkListActions {
  /** Submit drafts (approval Flows decide; ungated drafts release to approved). */
  submit: boolean;
  /** Post approved documents and drafts released by their submission. */
  post: boolean;
}

type Outcome = {
  id: string;
  number: string;
  result: "posted" | "submitted" | "pending" | "refused";
  reason?: string;
};

const SUBMITTABLE = new Set(["draft"]);
const POSTABLE = new Set(["draft", "approved"]);

/**
 * A documents list with keyboard row navigation and bulk lifecycle actions.
 * j / k (or ↓ / ↑ inside the table) move between rows, Enter opens the row,
 * x toggles its selection and Shift+x extends it. Selected drafts can be
 * submitted or posted, and approved documents posted, one by one through the
 * same commands as each record's own buttons: every document keeps its own
 * permission, approval Flow, period and posting checks, and every refusal is
 * reported against its number.
 */
export function RecordListBulkTable({
  header,
  rows,
  actions,
}: {
  header: ReactNode;
  rows: readonly BulkListRow[];
  actions: BulkListActions | null;
}) {
  const t = useTranslations("entry.bulk");
  const router = useRouter();
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [active, setActive] = useState<number>(-1);
  const [running, setRunning] = useState<{ done: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const anchor = useRef<string | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const selectable = actions !== null && (actions.post || actions.submit);

  const ids = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectedRows = rows.filter((row) => selected.has(row.id));
  const postable = selectedRows.filter((row) => POSTABLE.has(row.status));
  const submittable = selectedRows.filter((row) => SUBMITTABLE.has(row.status));

  const toggle = useCallback(
    (index: number, extend: boolean) => {
      const row = rows[index];
      if (!row) return;
      // The range starts at the previous toggle, read before it moves here.
      const from0 =
        anchor.current === null
          ? -1
          : rows.findIndex((candidate) => candidate.id === anchor.current);
      setSelected((current) => {
        const next = new Set(current);
        if (extend && from0 >= 0) {
          const [from, to] = [Math.min(from0, index), Math.max(from0, index)];
          const adding = !current.has(row.id);
          for (let i = from; i <= to; i += 1) {
            const id = rows[i]!.id;
            if (adding) next.add(id);
            else next.delete(id);
          }
        } else if (next.has(row.id)) next.delete(row.id);
        else next.add(row.id);
        return next;
      });
      anchor.current = row.id;
    },
    [rows],
  );

  const focusRow = useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(rows.length - 1, index));
      setActive(clamped);
      const link = tableRef.current?.querySelector<HTMLElement>(
        `[data-bulk-row="${clamped}"] a, [data-bulk-row="${clamped}"] button:not([role="checkbox"])`,
      );
      link?.focus({ preventScroll: false });
      tableRef.current
        ?.querySelector(`[data-bulk-row="${clamped}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    },
    [rows.length],
  );

  const container = () => tableRef.current;
  useShortcuts([
    {
      id: "listNext",
      label: () => t("keys.next"),
      binding: { character: "j" },
      scope: "page",
      container,
      enabled: () => rows.length > 0,
      run: () => focusRow(active + 1),
    },
    {
      id: "listPrevious",
      label: () => t("keys.previous"),
      binding: { character: "k" },
      scope: "page",
      container,
      enabled: () => rows.length > 0,
      run: () => focusRow(active <= 0 ? 0 : active - 1),
    },
    {
      id: "listToggle",
      label: () => t("keys.toggle"),
      binding: { character: "x" },
      scope: "page",
      container,
      enabled: () => selectable && active >= 0,
      run: () => toggle(active, false),
    },
    {
      id: "listExtend",
      label: () => t("keys.extend"),
      binding: { character: "X" },
      scope: "page",
      container,
      enabled: () => selectable && active >= 0,
      run: () => toggle(active, true),
    },
  ]);

  async function run(action: "post" | "submit") {
    const targets = action === "post" ? postable : submittable;
    if (targets.length === 0) return;
    const confirmed = await confirmDialog({
      title:
        action === "post"
          ? t("confirmPostTitle", { count: targets.length })
          : t("confirmSubmitTitle", { count: targets.length }),
      message: action === "post" ? t("confirmPostBody") : t("confirmSubmitBody"),
      confirmLabel:
        action === "post"
          ? t("post", { count: targets.length })
          : t("submit", { count: targets.length }),
    });
    if (!confirmed) return;
    const results: Outcome[] = [];
    setRunning({ done: 0, total: targets.length });
    const call = (name: "submit" | "post", documentId: string) =>
      fetchAppAction(
        "/api/documents/actions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: name, documentId }),
        },
        { fallback: t("refusedFallback") },
      );
    for (const row of targets) {
      // Posting a draft uses the native atomic submit/release/post command.
      const answer = await call(action, row.id);
      const outcome: Outcome = !answer.ok
        ? {
            id: row.id,
            number: row.number,
            result: "refused",
            reason: answer.error.displayMessage(t("refusedFallback")),
          }
        : (answer.data as { pendingApproval?: unknown } | null)?.pendingApproval === true
          ? { id: row.id, number: row.number, result: "pending" }
          : { id: row.id, number: row.number, result: action === "post" ? "posted" : "submitted" };
      results.push(outcome);
      setRunning({ done: results.length, total: targets.length });
    }
    setRunning(null);
    setOutcomes(results);
    setSelected(
      new Set(results.filter((result) => result.result === "refused").map((result) => result.id)),
    );
    const posted = results.filter((result) => result.result === "posted").length;
    const refused = results.filter((result) => result.result === "refused").length;
    if (refused === 0)
      toast.success(t("summary", { posted, pending: results.length - posted - refused, refused }));
    else toast.error(t("summary", { posted, pending: results.length - posted - refused, refused }));
    router.refresh();
  }

  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));
  return (
    <div ref={tableRef}>
      {selectable && (selected.size > 0 || running || outcomes) ? (
        <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-teal-200 bg-teal-50/90 px-3 py-2 text-sm text-teal-900 backdrop-blur dark:border-teal-900 dark:bg-teal-950/70 dark:text-teal-100">
          {running ? (
            <span role="status">{t("running", { done: running.done, total: running.total })}</span>
          ) : (
            <>
              <span className="font-medium">{t("selected", { count: selected.size })}</span>
              {actions?.post && postable.length > 0 ? (
                <Button size="sm" className="h-7 px-2.5 text-xs" onClick={() => void run("post")}>
                  {t("post", { count: postable.length })}
                </Button>
              ) : null}
              {actions?.submit && submittable.length > 0 ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => void run("submit")}
                >
                  {t("submit", { count: submittable.length })}
                </Button>
              ) : null}
              {selected.size > 0 ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  onClick={() => setSelected(new Set())}
                >
                  {t("clear")}
                </Button>
              ) : null}
            </>
          )}
          {outcomes && !running ? (
            <div className="basis-full text-xs">
              <p>
                {t("summary", {
                  posted: outcomes.filter((outcome) => outcome.result === "posted").length,
                  pending: outcomes.filter(
                    (outcome) => outcome.result === "pending" || outcome.result === "submitted",
                  ).length,
                  refused: outcomes.filter((outcome) => outcome.result === "refused").length,
                })}
              </p>
              <ul className="mt-1 space-y-0.5">
                {outcomes
                  .filter((outcome) => outcome.result === "refused")
                  .map((outcome) => (
                    <li key={outcome.id} className="text-red-700 dark:text-red-300">
                      <span className="font-mono">{outcome.number}</span> — {outcome.reason}
                    </li>
                  ))}
              </ul>
              <button type="button" className="mt-1 underline" onClick={() => setOutcomes(null)}>
                {t("dismiss")}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            {selectable ? (
              <TableHead className="w-9">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-teal-600"
                  aria-label={t("selectAll")}
                  checked={allSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = selected.size > 0 && !allSelected;
                  }}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(ids))}
                />
              </TableHead>
            ) : null}
            {header}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row, index) => (
            <TableRow
              key={row.id}
              data-bulk-row={index}
              aria-selected={selected.has(row.id) || undefined}
              onFocusCapture={() => setActive(index)}
              className={cn(
                index === active && "bg-slate-50 dark:bg-slate-800/40",
                selected.has(row.id) && "bg-teal-50/70 dark:bg-teal-950/30",
              )}
            >
              {selectable ? (
                <td className="w-9 px-3 align-middle">
                  <input
                    type="checkbox"
                    role="checkbox"
                    className="h-4 w-4 accent-teal-600"
                    aria-label={t("selectRow", { number: row.number })}
                    checked={selected.has(row.id)}
                    onClick={(event) => {
                      event.preventDefault();
                      toggle(index, event.shiftKey);
                    }}
                    onChange={() => undefined}
                  />
                </td>
              ) : null}
              {row.cells}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
