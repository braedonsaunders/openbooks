"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { apiJson } from "@/lib/api-error";
import { setupProviderLabel } from "./provider-label";

export function SetupContinueButton({ token, provider }: { token: string; provider: string }) {
  const t = useTranslations("payments.setup");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const json = await apiJson<{ redirectUrl?: string }>(`/api/pay/setup/${token}`, { method: "POST" }, t("continueFailed"));
      if (!json.redirectUrl) {
        setError(t("continueFailed"));
        return;
      }
      window.location.href = json.redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="h-11 w-full rounded-xl bg-teal-700 text-base font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
      >
        {busy ? "…" : t("continue", { provider: setupProviderLabel(provider) })}
      </button>
      {error ? (
        <p className="mt-2 text-center text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
