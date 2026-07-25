"use client";

import { useState } from "react";

export function PayButton({ token, provider }: { token: string; provider: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay/${token}`, { method: "POST" });
      const json = (await res.json()) as { redirectUrl?: string; error?: string };
      if (!res.ok || !json.redirectUrl) {
        setError(json.error ?? "checkout failed");
        setBusy(false);
        return;
      }
      window.location.href = json.redirectUrl;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="mt-6">
      <button
        type="button"
        onClick={pay}
        disabled={busy}
        className="h-11 w-full rounded-xl bg-teal-700 text-base font-semibold text-white transition hover:bg-teal-800 disabled:opacity-50"
      >
        {busy ? "Redirecting…" : provider === "gocardless" ? "Pay by bank debit" : "Pay now"}
      </button>
      {error ? (
        <p className="mt-2 text-center text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
