"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, Card, CardContent, Input, Label, SearchSelect } from "@openbooks/ui";
import { readApiErrorMessage } from "@/lib/api-error";

interface Shortfall {
  id: string;
  stockLocationCode: string;
  issuedOn: string;
  remainingQuantity: string;
  provisionalUnitCost: string;
}

/**
 * Negative-stock shortfalls of an item that still need the account their
 * issue charged. Shown only while some exist; a manager records each
 * account with a reason, after which a receipt can correct the shortfall's
 * provisional cost on that account.
 */
export function ItemShortfallAccounts({
  itemId,
  accountOptions,
  canManage,
}: {
  itemId: string;
  accountOptions: { value: string; label: string }[];
  canManage: boolean;
}) {
  const t = useTranslations("items.costing.shortfalls");
  const [shortfalls, setShortfalls] = useState<Shortfall[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { accountId: string; reason: string }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const res = await fetch(`/api/items/${itemId}/shortfalls`, { signal });
      if (!res.ok) return null;
      const body = (await res.json()) as { shortfalls?: Shortfall[] };
      return body.shortfalls ?? [];
    },
    [itemId],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted && rows) setShortfalls(rows);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [load]);

  if (shortfalls.length === 0) return null;

  async function record(shortfall: Shortfall) {
    const draft = drafts[shortfall.id] ?? { accountId: "", reason: "" };
    setBusyId(shortfall.id);
    try {
      const res = await fetch(`/api/items/${itemId}/shortfalls`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          deficitId: shortfall.id,
          accountId: draft.accountId,
          reason: draft.reason,
        }),
      });
      if (!res.ok) {
        toast.error(await readApiErrorMessage(res, t("failed")));
        return;
      }
      toast.success(t("recorded"));
      const rows = await load();
      if (rows) setShortfalls(rows);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div>
          <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">{t("title")}</h4>
          <p className="text-xs text-slate-500 dark:text-slate-400">{t("description")}</p>
        </div>
        {shortfalls.map((shortfall) => {
          const draft = drafts[shortfall.id] ?? { accountId: "", reason: "" };
          const update = (patch: Partial<typeof draft>) =>
            setDrafts({ ...drafts, [shortfall.id]: { ...draft, ...patch } });
          return (
            <div
              key={shortfall.id}
              className="grid gap-3 border-t border-slate-100 pt-3 text-sm first:border-t-0 first:pt-0 sm:grid-cols-2 lg:grid-cols-4 dark:border-slate-800"
            >
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t("location")}</div>
                <div>{shortfall.stockLocationCode}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t("issuedOn")}</div>
                <div className="tabular-nums">{shortfall.issuedOn}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">{t("remaining")}</div>
                <div className="tabular-nums">{shortfall.remainingQuantity}</div>
              </div>
              <div>
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  {t("provisionalCost")}
                </div>
                <div className="tabular-nums">{shortfall.provisionalUnitCost}</div>
              </div>
              {canManage ? (
                <fieldset
                  disabled={busyId === shortfall.id}
                  className="grid gap-3 sm:col-span-2 lg:col-span-4 lg:grid-cols-[1fr_2fr_auto] lg:items-end"
                >
                  <div className="space-y-1">
                    <Label>{t("account")}</Label>
                    <SearchSelect
                      value={draft.accountId}
                      onChange={(accountId: string) => update({ accountId })}
                      options={accountOptions}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>{t("reason")}</Label>
                    <Input
                      value={draft.reason}
                      placeholder={t("reasonPlaceholder")}
                      onChange={(event) => update({ reason: event.target.value })}
                    />
                  </div>
                  <Button
                    type="button"
                    onClick={() => void record(shortfall)}
                    disabled={!draft.accountId || draft.reason.trim().length === 0}
                  >
                    {t("record")}
                  </Button>
                </fieldset>
              ) : null}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
