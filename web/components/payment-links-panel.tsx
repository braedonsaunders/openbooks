"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Select } from "@openbooks/ui";
import { readApiErrorMessage } from "../lib/api-error";

type Link = {
  id: string;
  token: string;
  tokenState: "ok" | "unsealable";
  provider: string;
  amount: string;
  surchargeAmount: string;
  currency: string;
  status: string;
  expiresOn: string | null;
  paidPaymentDocumentId: string | null;
};

const STATUS_VARIANT: Record<string, "success" | "secondary" | "destructive" | "outline"> = {
  active: "secondary",
  paid: "success",
  void: "destructive",
  expired: "outline",
};

/** Online payment links on a posted customer invoice — create, copy, void. */
export function PaymentLinksPanel({
  documentId,
  canManage,
}: {
  documentId: string;
  canManage: boolean;
}) {
  const t = useTranslations("ar.paymentLinks");
  const tCommon = useTranslations("common");
  const [links, setLinks] = useState<Link[]>([]);
  const [providers, setProviders] = useState<string[]>([]);
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [available, setAvailable] = useState(true);

  // Fetch chain: every state update sits in a promise continuation (the fetch
  // response), never synchronously in the effect body.
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/payments/links?documentId=${documentId}`);
      if (res.status === 404) {
        setAvailable(false);
        setError(null);
        return;
      }
      if (!res.ok) {
        setError(await readApiErrorMessage(res, tCommon("feedback.somethingWentWrong")));
        return;
      }
      const json = (await res.json()) as { links: Link[]; providers: string[] };
      setAvailable(true);
      setError(null);
      setLinks(json.links);
      setProviders(json.providers);
      setProvider((p) => p || json.providers[0] || "");
    } catch {
      setError(tCommon("feedback.somethingWentWrong"));
    }
  }, [documentId, tCommon]);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  if (!available || (providers.length === 0 && !error)) return null;

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/payments/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId, provider }),
      });
      // The refusal reads through the shared helper so message, remedy and
      // code render instead of the bare status text.
      if (!res.ok) {
        setError(await readApiErrorMessage(res, tCommon("feedback.somethingWentWrong")));
        return;
      }
      await load();
    } catch {
      setError(tCommon("feedback.somethingWentWrong"));
    } finally {
      setBusy(false);
    }
  }

  async function voidLink(id: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/payments/links/${id}`, { method: "DELETE" });
      if (!res.ok) {
        setError(await readApiErrorMessage(res, tCommon("feedback.somethingWentWrong")));
        return;
      }
      await load();
    } catch {
      setError(tCommon("feedback.somethingWentWrong"));
    } finally {
      setBusy(false);
    }
  }

  function copy(token: string) {
    const url = `${window.location.origin}/pay/${token}`;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(token);
      setTimeout(() => setCopied(null), 1500);
    });
  }

  return (
    <section className="space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {t("title")}
        </h3>
        {canManage ? (
          <div className="flex items-center gap-2">
            {providers.length > 1 ? (
              <Select
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                className="h-8 text-xs"
              >
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p === "gocardless" ? "GoCardless" : p === "adyen" ? "Adyen" : "Stripe"}
                  </option>
                ))}
              </Select>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !provider}
              onClick={() => void create()}
            >
              {t("create")}
            </Button>
          </div>
        ) : null}
      </div>
      {error ? (
        <p className="text-xs text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
      {links.length === 0 && !error ? (
        <p className="text-xs text-slate-400 dark:text-slate-500">{t("empty")}</p>
      ) : links.length > 0 ? (
        <ul className="space-y-1.5">
          {links.map((link) => (
            <li key={link.id} className="flex items-center gap-2 text-sm">
              <Badge variant={STATUS_VARIANT[link.status] ?? "secondary"}>
                {t(`status.${link.status}`)}
              </Badge>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {link.provider === "gocardless"
                  ? "GoCardless"
                  : link.provider === "adyen"
                    ? "Adyen"
                    : "Stripe"}
              </span>
              {link.status === "active" ? (
                <>
                  {link.tokenState === "unsealable" ? (
                    <span className="text-xs text-red-600 dark:text-red-400" role="alert">
                      {t("unavailable")}: {t("reissueHint")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="text-xs text-teal-700 hover:underline dark:text-teal-300"
                      onClick={() => copy(link.token)}
                    >
                      {copied === link.token ? t("copied") : t("copyLink")}
                    </button>
                  )}
                  {canManage ? (
                    <button
                      type="button"
                      className="text-xs text-red-600 hover:underline dark:text-red-400"
                      disabled={busy}
                      onClick={() => void voidLink(link.id)}
                    >
                      {t("void")}
                    </button>
                  ) : null}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
