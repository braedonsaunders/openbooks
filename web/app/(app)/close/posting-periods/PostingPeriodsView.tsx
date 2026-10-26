"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { PagedTable } from "../../../../components/paged-table";
import { enumLabel } from "@/lib/enum-label";
import { toast } from "sonner";
import { readApiErrorMessage } from "@/lib/api-error";
import { ArrowLeft, Play } from "lucide-react";
import { Badge, Button, Card, CardContent } from "@openbooks/ui";
import { PermissionHint } from "../../../../components/permission-hint";

type Candidate = {
  documentId: string;
  documentNumber: string;
  kind: string;
  effectiveDate: string;
  periodId: string | null;
  periodName: string | null;
  blocked: boolean;
  blockReason: string | null;
  adjustment?: boolean;
  adjustmentPeriod?: { id: string; name: string } | null;
};

type CommitResult = {
  assigned: { documentId: string; periodId: string }[];
  skipped: { documentId: string; reason: string }[];
  refused: { documentId: string; reason: string }[];
};

export function PostingPeriodsView({
  bookId,
  runId,
  canManageBooks,
  manageBooksLabel,
  canPreview,
  initialRows,
  initialError,
}: {
  bookId: string | null;
  runId: string | null;
  canManageBooks: boolean;
  manageBooksLabel: string;
  canPreview: boolean;
  initialRows: Candidate[] | null;
  initialError: string | null;
}) {
  const t = useTranslations("close");
  const tc = useTranslations("common");
  // Every decided document kind, so a preview row never renders the
  // "Unknown value" fallback for a kind the close model already knows. Only
  // a kind no registry decided — which the preview blocks with operator
  // copy — can still fall back.
  const transactionKindLabels = {
    vendor_bill: tc("transactionTypes.vendorBill"),
    vendor_credit: tc("transactionTypes.vendorCredit"),
    customer_invoice: tc("transactionTypes.customerInvoice"),
    customer_credit: tc("transactionTypes.customerCredit"),
    cash_sale: tc("transactionTypes.cashSale"),
    cash_refund: tc("transactionTypes.cashRefund"),
    card_charge: tc("transactionTypes.cardCharge"),
    card_refund: tc("transactionTypes.cardRefund"),
    check: tc("transactionTypes.check"),
    deposit: tc("transactionTypes.deposit"),
    transfer: tc("transactionTypes.transfer"),
    project_charge: tc("transactionTypes.projectCharge"),
    internal_billing: tc("transactionTypes.internalBilling"),
    pay_run: tc("transactionTypes.payRun"),
    customer_payment: tc("transactionTypes.customerPayment"),
    vendor_payment: tc("transactionTypes.vendorPayment"),
    expense_report: tc("transactionTypes.expenseReport"),
    journal: tc("transactionTypes.journalEntry"),
    purchase_receipt: tc("transactionTypes.goodsReceipt"),
    sales_fulfillment: tc("transactionTypes.fulfillment"),
    sales_order: tc("transactionTypes.salesOrder"),
    purchase_order: tc("transactionTypes.purchaseOrder"),
    quote: tc("transactionTypes.estimate"),
    pick_list: tc("transactionTypes.pickList"),
    shipment: tc("transactionTypes.shipment"),
    field_ticket: tc("transactionTypes.fieldTicket"),
    rma: tc("transactionTypes.returnAuthorization"),
  } satisfies Record<string, string>;
  const [rows, setRows] = useState<Candidate[] | null>(initialRows);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CommitResult | null>(null);
  const [previewFailed, setPreviewFailed] = useState(initialError !== null);
  // The server's named refusal for the failed preview: the toast alone
  // vanishes, so the panel pins it beside Retry until the next load.
  const [previewError, setPreviewError] = useState<string | null>(initialError);

  const loadPreview = useCallback(
    async (signal?: AbortSignal) => {
      if (!bookId) return;
      const url = `/api/close/posting-periods?bookId=${encodeURIComponent(bookId)}`;
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          throw new Error(await readApiErrorMessage(response, t("postingPeriods.previewFailed")));
        }
        const preview = (await response.json()) as { rows?: Candidate[] };
        // A body without rows is a failed preview, not an empty table: fail
        // loudly instead of crashing the table on undefined rows.
        if (!Array.isArray(preview.rows)) throw new Error(t("postingPeriods.previewFailed"));
        setRows(preview.rows);
        setPreviewFailed(false);
        setPreviewError(null);
      } catch (e) {
        if (signal?.aborted) return;
        const message = e instanceof Error ? e.message : t("postingPeriods.previewFailed");
        setPreviewFailed(true);
        setPreviewError(message);
        toast.error(message);
      }
    },
    [bookId, t],
  );

  const assignable = (rows ?? []).filter((row) => !row.blocked);
  const blocked = (rows ?? []).filter((row) => row.blocked);
  // Blocked rows whose regular period is closed but whose fiscal year keeps
  // an open adjustment period, grouped so each group commits to exactly the
  // adjustment period the operator chose — never silently diverted.
  const adjustmentGroups = (() => {
    const groups = new Map<string, { name: string; rows: Candidate[] }>();
    for (const row of blocked) {
      if (!row.adjustmentPeriod) continue;
      const entry = groups.get(row.adjustmentPeriod.id) ?? {
        name: row.adjustmentPeriod.name,
        rows: [],
      };
      entry.rows.push(row);
      groups.set(row.adjustmentPeriod.id, entry);
    }
    return [...groups.entries()];
  })();

  async function commit(adjustmentPeriodId?: string) {
    setBusy(true);
    try {
      const response = await fetch("/api/close/posting-periods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bookId,
          documentIds: adjustmentPeriodId
            ? (adjustmentGroups.find(([id]) => id === adjustmentPeriodId)?.[1].rows ?? []).map(
                (row) => row.documentId,
              )
            : assignable.map((row) => row.documentId),
          adjustmentPeriodId,
        }),
      });
      // The status is checked before the body is trusted: a non-JSON failure
      // body must surface the named refusal, never a SyntaxError from
      // response.json().
      if (!response.ok) {
        toast.error(await readApiErrorMessage(response, t("postingPeriods.commitFailed")));
        return;
      }
      const payload = (await response.json().catch(() => null)) as CommitResult | null;
      if (!payload) {
        toast.error(t("postingPeriods.commitFailed"));
        return;
      }
      setResult(payload);
      toast.success(t("postingPeriods.committed", { count: payload.assigned.length }));
      setRows((current) =>
        (current ?? []).filter(
          (row) =>
            !payload.assigned.some((item) => item.documentId === row.documentId) &&
            !payload.skipped.some((item) => item.documentId === row.documentId),
        ),
      );
    } catch {
      toast.error(t("postingPeriods.commitFailed"));
    } finally {
      setBusy(false);
    }
  }

  // No book context (bookmark, manual navigation): a neutral empty state with
  // a way back, never a throw into the route error boundary. The page is
  // normally opened from a close run, which always supplies ?book=.
  if (!bookId) {
    return (
      <Card>
        <CardContent className="space-y-2">
          <p className="text-sm text-slate-500">{t("postingPeriods.needsBook")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={runId ? `/close?run=${encodeURIComponent(runId)}` : "/close"}
              className="inline-flex items-center gap-1 text-sm"
            >
              <ArrowLeft size={14} />
              {t("postingPeriods.backToClose")}
            </Link>
            {canManageBooks ? (
              <Link
                href="/admin/setup/accounting-books"
                className="inline-flex items-center gap-1 text-sm"
              >
                {manageBooksLabel}
              </Link>
            ) : null}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-500">{t("postingPeriods.previewDescription")}</p>
      {!canPreview ? (
        <PermissionHint permission="close.run" action={t("postingPeriods.title")} />
      ) : previewFailed ? (
        <div role="alert" className="space-y-2 text-sm text-red-600">
          <p>{previewError ?? t("postingPeriods.previewFailed")}</p>
          <Button variant="outline" onClick={() => void loadPreview()}>
            {tc("actions.retry")}
          </Button>
        </div>
      ) : rows === null ? (
        <p className="text-sm text-slate-500">{t("postingPeriods.loading")}</p>
      ) : (
        <PagedTable
          source="close_posting_periods"
          emptyAsRow
          rows={rows}
          toolbarAfter={
            assignable.length > 0 || adjustmentGroups.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                {assignable.length > 0 ? (
                  <Button onClick={() => void commit()} disabled={busy}>
                    <Play size={14} />
                    {t("postingPeriods.assign", { count: assignable.length })}
                  </Button>
                ) : null}
                {adjustmentGroups.map(([id, group]) => (
                  <Button
                    key={id}
                    variant="outline"
                    onClick={() => void commit(id)}
                    disabled={busy}
                  >
                    <Play size={14} />
                    {t("postingPeriods.assignAdjustment", {
                      count: group.rows.length,
                      name: group.name,
                    })}
                  </Button>
                ))}
              </div>
            ) : undefined
          }
          rowKey={(row) => row.documentId}
          searchable
          empty={t("postingPeriods.empty")}
          columns={[
            {
              key: "document",
              header: t("postingPeriods.document"),
              cell: (row) => <span className="font-mono">{row.documentNumber}</span>,
              search: (row) => row.documentNumber,
            },
            {
              key: "kind",
              header: t("postingPeriods.kind"),
              cell: (row) => enumLabel(row.kind, transactionKindLabels, tc("labels.unknownValue")),
              search: (row) => row.kind,
            },
            {
              key: "date",
              header: t("postingPeriods.effectiveDate"),
              cell: (row) => row.effectiveDate,
            },
            {
              key: "period",
              header: t("postingPeriods.period"),
              cell: (row) => row.periodName ?? "—",
              search: (row) => row.periodName ?? "",
            },
            {
              key: "status",
              header: t("postingPeriods.status"),
              cell: (row) =>
                row.blocked ? (
                  <Badge variant="destructive">{row.blockReason}</Badge>
                ) : (
                  <Badge variant="success">{t("postingPeriods.assignable")}</Badge>
                ),
            },
          ]}
        />
      )}
      {blocked.length > 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          {t("postingPeriods.blockedNote", { count: blocked.length })}
        </p>
      ) : null}
      {result && result.refused.length > 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          {t("postingPeriods.refusedNote", { count: result.refused.length })}
        </p>
      ) : null}
      {result && result.skipped.length > 0 ? (
        <p className="mt-2 text-sm text-slate-500">
          {t("postingPeriods.skippedNote", { count: result.skipped.length })}
        </p>
      ) : null}
    </div>
  );
}
