"use client";

import { useIdentityState } from "@/lib/use-identity-state";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, FieldLabel, Input, Select } from "@openbooks/ui";
import Link from "next/link";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { DateField } from "./date-field";

export interface CashDepositAccountOption {
  value: string;
  label: string;
}

/**
 * Till drop ("Deposit cash to bank") for a posted cash sale. Records the
 * cashier's bank drop as a native till-cash → bank transfer carrying the
 * sale link and the bank slip number; the bookkeeper confirms and matches
 * it in Banking. The server fences the destination to the configured
 * deposit accounts and the amount to the sale's undropped till cash, so a
 * cashier needs no banking or GL grant — only `cash_sales.deposit`.
 *
 * Renders inside the Tenders tab beside the settled cash: that is where
 * the counted till balance lives, and an inline section avoids a nested
 * modal inside the drawer's focus and scroll locks.
 */
type TillWindow = {
  after: string | null;
  through: string;
  salesCount: number;
  tendered: string;
  dropped: string;
  difference: string;
};

type SavedDeposit = {
  id: string;
  documentNumber: string;
  posted: boolean;
  pendingApproval: boolean;
  postRefusal: string | null;
};

/**
 * `mode="till"` records a drop by till and date for a sale not yet posted:
 * cash leaves the till before the back office posts its sales, and the
 * form shows the till's window since its previous drop (tendered vs.
 * dropped) so the cashier sees what the count explains.
 */
export function CashDepositSection({
  saleId,
  currency,
  defaultDate,
  bankOptions,
  sourceOptions,
  subsidiaryId,
  mode: initialMode = "sale",
  modes,
}: {
  saleId: string;
  currency: string;
  defaultDate: string;
  bankOptions: CashDepositAccountOption[];
  sourceOptions: CashDepositAccountOption[];
  subsidiaryId?: string | null;
  mode?: "sale" | "till";
  /** Drop scopes the operator may choose between; a single scope shows no choice. */
  modes?: readonly ("sale" | "till")[];
}) {
  const t = useTranslations("ar");
  // A bank drop usually covers several days of a till's cash, so a posted
  // sale offers the till-level drop beside the drop of its own cash.
  const [mode, setMode] = useState<"sale" | "till">(initialMode);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(defaultDate);
  // The last sale date the drop's cash covers; follows the drop date until
  // the cashier names an earlier cutoff.
  const [coversThrough, setCoversThrough] = useState<string | null>(null);
  const cutoff = coversThrough ?? date;
  const [bankAccountId, setBankAccountId] = useState(bankOptions[0]?.value ?? "");
  const [slipNumber, setSlipNumber] = useState("");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [savedDeposit, setSavedDeposit] = useState<SavedDeposit | null>(null);
  const [drops, setDrops] = useState<
    | {
        transferId: string;
        documentNumber: string;
        dropDate: string;
        amount: string;
        status: string;
        slipNumber: string | null;
      }[]
    | null
  >(null);
  const [reload, setReload] = useState(0);
  const [reason, setReason] = useState("");
  const tillAccountId =
    mode === "till"
      ? sourceOptions.some((o) => o.value === sourceAccountId)
        ? sourceAccountId
        : (sourceOptions[0]?.value ?? "")
      : "";
  const [tillWindow, setTillWindow] = useIdentityState<TillWindow | null>(
    [mode, tillAccountId, cutoff, reload, subsidiaryId],
    null,
  );
  const [windowRefusal, setWindowRefusal] = useIdentityState<string | null>(
    [mode, tillAccountId, cutoff, reload, subsidiaryId],
    null,
  );

  // The till's window a drop on this date closes: refreshed when the till,
  // the date or a recorded drop changes.
  useEffect(() => {
    if (mode !== "till" || !tillAccountId || !/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) {
      return;
    }
    let live = true;
    const query = new URLSearchParams({ tillAccountId, date: cutoff });
    if (subsidiaryId) query.set("subsidiaryId", subsidiaryId);
    fetch(`/api/cash-sales/till-drops?${query}`, { headers: { accept: "application/json" } })
      .then(async (res) => {
        if (res.ok) return res.json();
        const body = (await res.json().catch(() => null)) as {
          error?: unknown;
          remedy?: unknown;
        } | null;
        if (live)
          setWindowRefusal(
            [
              typeof body?.error === "string" ? body.error : t("tenders.depositFailed"),
              typeof body?.remedy === "string" ? body.remedy : "",
            ]
              .filter(Boolean)
              .join(" "),
          );
        return null;
      })
      .then((body) => {
        if (live) setTillWindow(body as TillWindow | null);
      })
      .catch(() => {
        if (live) setWindowRefusal(t("tenders.depositFailed"));
      });
    return () => {
      live = false;
    };
  }, [mode, tillAccountId, cutoff, reload, subsidiaryId, t, setWindowRefusal, setTillWindow]);

  // Recorded drops beside the form: the cashier sees what already left the
  // till (a refused POST still records a draft drop), so a double drop
  // reads as a duplicate before it is recorded, never after.
  useEffect(() => {
    if (mode === "till") return;
    let live = true;
    fetch(`/api/cash-sales/${saleId}/deposit`, { headers: { accept: "application/json" } })
      .then((res) => (res.ok ? res.json() : null))
      .then((body) => {
        if (!live) return;
        const rows = (body as { drops?: unknown } | null)?.drops;
        if (Array.isArray(rows)) setDrops(rows as NonNullable<typeof drops>);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [saleId, reload, mode]);

  const selectedBank = bankOptions.some((o) => o.value === bankAccountId)
    ? bankAccountId
    : (bankOptions[0]?.value ?? "");

  async function record() {
    setBusy(true);
    setRefusal(null);
    setSavedDeposit(null);
    try {
      const response =
        mode === "till"
          ? await fetch("/api/cash-sales/till-drops", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                tillAccountId,
                amount: amount.trim(),
                date,
                coversThrough: cutoff,
                bankAccountId: selectedBank,
                slipNumber: slipNumber.trim(),
                ...(subsidiaryId ? { subsidiaryId } : {}),
                ...(reason.trim() ? { reason: reason.trim() } : {}),
              }),
            })
          : await fetch(`/api/cash-sales/${saleId}/deposit`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                amount: amount.trim(),
                date,
                bankAccountId: selectedBank,
                slipNumber: slipNumber.trim(),
                ...(sourceOptions.length > 1 && sourceAccountId ? { sourceAccountId } : {}),
              }),
            });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (!response.ok) {
        const message =
          typeof body.error === "string" && body.error ? body.error : t("tenders.depositFailed");
        const remedy = typeof body.remedy === "string" && body.remedy ? ` ${body.remedy}` : "";
        setRefusal(`${message}${remedy}`);
        return;
      }
      const pendingApproval = body.pendingApproval === true;
      const postRefusal =
        typeof body.postRefusal === "string" && body.postRefusal.trim() ? body.postRefusal : null;
      if (
        typeof body.id !== "string" ||
        !isUuid(body.id) ||
        typeof body.documentNumber !== "string" ||
        !body.documentNumber.trim() ||
        typeof body.posted !== "boolean" ||
        (body.pendingApproval !== undefined && typeof body.pendingApproval !== "boolean") ||
        (body.postRefusal !== undefined && typeof body.postRefusal !== "string") ||
        (body.posted
          ? typeof body.entryId !== "string" ||
            !isUuid(body.entryId) ||
            pendingApproval ||
            postRefusal !== null
          : body.entryId !== null || (!pendingApproval && postRefusal === null))
      ) {
        setRefusal(t("tenders.depositOutcomeUnknown"));
        return;
      }
      const documentNumber = body.documentNumber;
      setSavedDeposit({
        id: body.id,
        documentNumber,
        posted: body.posted,
        pendingApproval,
        postRefusal,
      });
      setAmount("");
      setSlipNumber("");
      setReason("");
      setCoversThrough(null);
      setReload((n) => n + 1);
      const outcomeMessage = t(
        body.posted
          ? "tenders.depositPosted"
          : pendingApproval
            ? "tenders.depositPendingApproval"
            : "tenders.depositNotPosted",
        { documentNumber },
      );
      if (body.posted) toast.success(outcomeMessage);
      else toast.warning(outcomeMessage);
    } catch {
      // A lost response does not prove that the native transfer was rolled
      // back. Its saved identity must be checked before another command.
      setRefusal(t("tenders.depositOutcomeUnknown"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-slate-200 pt-3 dark:border-slate-700">
      <FieldLabel fieldName={t("tenders.depositTitle")}>{t("tenders.depositTitle")}</FieldLabel>
      {bankOptions.length === 0 ? (
        <p className="text-xs text-slate-500 dark:text-slate-400">
          {t("tenders.depositNeedsSetup")}
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <FieldLabel fieldName={t("tenders.depositAmount")}>
                {t("tenders.depositAmount")}
              </FieldLabel>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                aria-label={`${t("tenders.depositAmount")} (${currency})`}
              />
            </div>
            <div>
              <FieldLabel fieldName={t("tenders.depositDate")}>
                {t("tenders.depositDate")}
              </FieldLabel>
              <DateField value={date} onChange={(value) => setDate(value)} />
            </div>
            <div>
              <FieldLabel fieldName={t("tenders.depositBank")}>
                {t("tenders.depositBank")}
              </FieldLabel>
              <Select value={selectedBank} onChange={(e) => setBankAccountId(e.target.value)}>
                {bankOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel fieldName={t("tenders.depositSlip")}>
                {t("tenders.depositSlip")}
              </FieldLabel>
              <Input
                value={slipNumber}
                onChange={(e) => setSlipNumber(e.target.value)}
                placeholder={t("tenders.depositSlipPlaceholder")}
              />
            </div>
          </div>
          {modes && modes.length > 1 ? (
            <div
              role="radiogroup"
              aria-label={t("tenders.dropScope")}
              className="flex flex-wrap gap-3 text-xs text-slate-700 dark:text-slate-300"
            >
              {modes.map((option) => (
                <label key={option} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name={`drop-scope-${saleId}`}
                    checked={mode === option}
                    onChange={() => setMode(option)}
                  />
                  {t(option === "till" ? "tenders.dropScopeTill" : "tenders.dropScopeSale")}
                </label>
              ))}
            </div>
          ) : null}
          {mode === "till" ? (
            <div className="max-w-xs">
              <FieldLabel fieldName={t("tenders.tillCoversThrough")}>
                {t("tenders.tillCoversThrough")}
              </FieldLabel>
              <DateField
                value={cutoff}
                max={date}
                onChange={(value) => setCoversThrough(value || null)}
              />
            </div>
          ) : null}
          {mode === "till" && tillWindow ? (
            <p className="text-xs text-slate-600 dark:text-slate-300">
              {t(tillWindow.after ? "tenders.tillWindow" : "tenders.tillWindowFirst", {
                after: tillWindow.after ?? "",
                through: tillWindow.through,
                sales: tillWindow.salesCount,
                tendered: tillWindow.tendered,
                dropped: tillWindow.dropped,
                currency,
              })}
            </p>
          ) : null}
          {mode === "till" ? (
            <div className="max-w-md">
              <FieldLabel fieldName={t("tenders.tillReason")}>{t("tenders.tillReason")}</FieldLabel>
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("tenders.tillReasonHint")}
              />
            </div>
          ) : null}
          {sourceOptions.length > 1 ? (
            <div className="max-w-xs">
              <FieldLabel fieldName={t("tenders.depositSource")}>
                {t("tenders.depositSource")}
              </FieldLabel>
              <Select value={sourceAccountId} onChange={(e) => setSourceAccountId(e.target.value)}>
                {mode === "till" ? null : (
                  <option value="">{t("tenders.depositSourceDefault")}</option>
                )}
                {sourceOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {windowRefusal && mode === "till" ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {windowRefusal}
            </p>
          ) : null}
          {refusal ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-400">
              {refusal}
            </p>
          ) : null}
          {savedDeposit ? (
            <div
              role={savedDeposit.posted ? "status" : "alert"}
              className={
                savedDeposit.posted
                  ? "text-xs text-emerald-700 dark:text-emerald-300"
                  : "text-xs text-amber-700 dark:text-amber-300"
              }
            >
              <p>
                {t(
                  savedDeposit.posted
                    ? "tenders.depositPosted"
                    : savedDeposit.pendingApproval
                      ? "tenders.depositPendingApproval"
                      : "tenders.depositNotPosted",
                  { documentNumber: savedDeposit.documentNumber },
                )}
              </p>
              {savedDeposit.postRefusal ? <p>{savedDeposit.postRefusal}</p> : null}
              <Link href={`/banking/transactions?doc=${savedDeposit.id}`} className="underline">
                {t("tenders.depositReview")}
              </Link>
            </div>
          ) : null}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void record()}
            >
              {busy ? t("tenders.depositRecording") : t("tenders.depositAction")}
            </Button>
          </div>
        </>
      )}
      {drops !== null && drops.length > 0 ? (
        <div className="space-y-1 pt-1">
          <FieldLabel fieldName={t("tenders.depositHistory")}>
            {t("tenders.depositHistory")}
          </FieldLabel>
          <ul className="space-y-1">
            {drops.map((drop) => (
              <li
                key={drop.transferId}
                className="flex flex-wrap items-baseline gap-x-2 text-xs text-slate-600 dark:text-slate-300"
              >
                <span className="font-medium tabular-nums">{drop.documentNumber}</span>
                <span className="tabular-nums">{drop.dropDate}</span>
                <span className="tabular-nums">
                  {drop.amount} {currency}
                </span>
                <span>{drop.status}</span>
                {drop.slipNumber ? (
                  <span className="text-slate-500 dark:text-slate-400">{drop.slipNumber}</span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
