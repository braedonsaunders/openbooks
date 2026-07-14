"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SyncButton({ source, label }: { source: string; label: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const router = useRouter();

  async function sync() {
    setBusy(true);
    setResult(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const tb = data.tb;
      setResult(
        `Synced in ${(data.durationMs / 1000).toFixed(1)}s — ${data.newEntries} new, ` +
        `${data.reversedEntries} reversed, ${data.unchanged} unchanged. ` +
        `Trial balance: ${tb.matches}/${tb.accounts} accounts match ${label}` +
        (tb.mismatches.length ? ` (${tb.mismatches.length} MISMATCHES)` : " — exact."),
      );
      router.refresh();
    } catch (e) {
      setResult(`Sync failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn" onClick={sync} disabled={busy}>
        {busy ? `Syncing from ${label}…` : `Sync from ${label}`}
      </button>
      {result && <p className="query-meta">{result}</p>}
    </div>
  );
}
