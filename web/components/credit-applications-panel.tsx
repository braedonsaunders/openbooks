"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, Input } from "@openbooks/ui";
import { useMoney } from "./money-provider";

type Settlement = {
  applicationId: string;
  documentId: string | null;
  documentNumber: string | null;
  documentKind: string | null;
  documentDate: string | null;
  amount: string;
  appliedOn: string;
};

type State = {
  lineId: string | null;
  amount: string;
  applied: string;
  open: string;
  currency: string;
  settlements: Settlement[];
};

type OpenItem = {
  lineId: string;
  documentNumber: string | null;
  entryNumber: string;
  dueDate: string | null;
  open: string;
  currency: string;
};

const units = (value: string): number => Math.round(Number(value || "0") * 10000);

/**
 * Apply a posted credit memo to open items with NO cash, and release what it
 * already settled.
 *
 * A credit that fully covers an invoice previously had no workflow at all —
 * posting a payment refuses zero cash allocations, so the balance stayed open
 * on both documents with nothing an operator could do about it. Applying a
 * credit moves no money, so this writes settlement evidence and no journal
 * entry; the engine owns that decision, this is only its control surface.
 *
 * Remaining balances come from the same `applications` rows the engine checks
 * against, so the figure shown here cannot drift from the one that refuses.
 */
export function CreditApplicationsPanel({
  documentId,
  side,
  partyId,
  canApply,
}: {
  documentId: string;
  side: "ap" | "ar";
  partyId: string | null;
  canApply: boolean;
}) {
  const t = useTranslations("payments.creditApplications");
  const tCommon = useTranslations("common");
  const { money } = useMoney();
  const [state, setState] = useState<State | null>(null);
  const [available, setAvailable] = useState(true);
  const [openItems, setOpenItems] = useState<OpenItem[] | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per logical apply: minted on first submit and reused across
  // retries until the outcome is visible, so a network retry resolves to the
  // settlement it already wrote instead of writing a second one beside it.
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  const load = useCallback(() => {
    return fetch(
      `/api/payments/credit-applications?side=${side}&documentId=${encodeURIComponent(documentId)}`,
    ).then((res) => {
      // 404 is the honest answer for a credit this reader may not see, or a
      // kind that cannot be settled here; the panel simply does not appear.
      if (res.status === 404 || res.status === 403) {
        setAvailable(false);
        return;
      }
      if (!res.ok) return;
      return (res.json() as Promise<{ state: State | null }>).then((json) => {
        setState(json.state);
      });
    });
  }, [documentId, side]);

  useEffect(() => {
    void load();
  }, [load]);

  // A credit with nothing left and nothing settled has nothing to say. An
  // unposted credit has no open-item line at all.
  if (!available || !state || state.lineId === null) return null;
  const remaining = units(state.open);
  if (remaining <= 0 && state.settlements.length === 0) return null;

  async function startApply() {
    if (!partyId) return;
    setBusy(true);
    setError(null);
    const res = await fetch(
      `/api/payments/open-items?partyId=${encodeURIComponent(partyId)}&side=${side}`,
    );
    const json = (await res.json().catch(() => ({}))) as { items?: OpenItem[]; error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? res.statusText);
      return;
    }
    setOpenItems(json.items ?? []);
    setAmounts({});
  }

  async function apply() {
    if (!state || !partyId) return;
    const credits = Object.entries(amounts)
      .filter(([, amount]) => units(amount) > 0)
      .map(([toLineId, amount]) => ({
        fromLineId: state.lineId!,
        toLineId,
        amount,
        sourceDocumentId: documentId,
      }));
    if (credits.length === 0) {
      setError(t("nothingSelected"));
      return;
    }
    setBusy(true);
    setError(null);
    const key = pendingKey ?? crypto.randomUUID();
    setPendingKey(key);
    try {
      const res = await fetch("/api/payments/credit-applications", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({
          partyId,
          side,
          appliedOn: new Date().toISOString().slice(0, 10),
          credits,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(json.error ?? res.statusText);
        // A named refusal means this key's settlement cannot serve a retry:
        // the next attempt must start a fresh request. A network-level
        // failure keeps the key, so the retry replays rather than re-applies.
        setPendingKey(null);
        return;
      }
      setPendingKey(null);
      setOpenItems(null);
      setAmounts({});
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function release(applicationId: string) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/payments/credit-applications", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ applicationId, side }),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (!res.ok) {
      setError(json.error ?? res.statusText);
      return;
    }
    await load();
  }

  const currency = state.currency;
  return (
    <section className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("title")}
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">
            {t("remaining", { amount: money(state.open, { currency }) })}
          </span>
          {canApply && remaining > 0 && openItems === null ? (
            <Button size="sm" variant="outline" disabled={busy || !partyId} onClick={() => void startApply()}>
              {t("apply")}
            </Button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}

      {openItems !== null ? (
        <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          {openItems.length === 0 ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">{t("noOpenItems")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                  <th className="px-2 py-1 font-medium">{t("document")}</th>
                  <th className="px-2 py-1 font-medium">{tCommon("labels.dueDate")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("openAmount")}</th>
                  <th className="px-2 py-1 text-right font-medium">{t("applyAmount")}</th>
                </tr>
              </thead>
              <tbody>
                {openItems.map((item) => (
                  <tr key={item.lineId} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                    <td className="px-2 py-1 font-medium tabular-nums">
                      {item.documentNumber ?? item.entryNumber}
                    </td>
                    <td className="px-2 py-1 text-slate-500 tabular-nums dark:text-slate-400">
                      {item.dueDate ?? "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums">
                      {money(item.open, { currency: item.currency })}
                    </td>
                    <td className="px-2 py-1 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        className="h-8 w-28 text-right"
                        value={amounts[item.lineId] ?? ""}
                        onChange={(e) =>
                          setAmounts((prev) => ({ ...prev, [item.lineId]: e.target.value }))
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setOpenItems(null)}>
              {tCommon("actions.cancel")}
            </Button>
            <Button size="sm" disabled={busy || openItems.length === 0} onClick={() => void apply()}>
              {t("confirmApply")}
            </Button>
          </div>
        </div>
      ) : null}

      {state.settlements.length > 0 ? (
        <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500 dark:border-slate-800 dark:text-slate-400">
                <th className="px-3 py-2 font-medium">{t("document")}</th>
                <th className="px-3 py-2 font-medium">{t("appliedOn")}</th>
                <th className="px-3 py-2 text-right font-medium">{tCommon("labels.amount")}</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {state.settlements.map((settlement) => (
                <tr
                  key={settlement.applicationId}
                  className="border-b border-slate-100 last:border-0 dark:border-slate-800"
                >
                  <td className="px-3 py-2 font-medium tabular-nums">
                    {settlement.documentNumber ?? "—"}
                  </td>
                  <td className="px-3 py-2 text-slate-500 tabular-nums dark:text-slate-400">
                    {settlement.appliedOn}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {money(settlement.amount, { currency })}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {canApply ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void release(settlement.applicationId)}
                      >
                        {t("release")}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
