"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function DecideButtons({ requestId, stepNumber }: { requestId: string; stepNumber: number }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function go(decision: "approved" | "rejected") {
    const note = decision === "rejected" ? prompt("Rejection reason:") ?? undefined : undefined;
    if (decision === "rejected" && !note) return;
    setBusy(true); setErr(null);
    const res = await fetch("/api/bills/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "decide", requestId, stepNumber, decision, note }),
    });
    const data = await res.json();
    if (!res.ok) setErr(data.error);
    setBusy(false);
    router.refresh();
  }

  return (
    <span style={{ display: "inline-flex", gap: 6 }}>
      <button className="btn" style={{ padding: "4px 10px", fontSize: 12.5 }} disabled={busy} onClick={() => go("approved")}>Approve</button>
      <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12.5 }} disabled={busy} onClick={() => go("rejected")}>Reject</button>
      {err && <span style={{ color: "var(--danger)", fontSize: 12 }}>{err}</span>}
    </span>
  );
}
