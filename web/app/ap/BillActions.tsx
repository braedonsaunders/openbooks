"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function BillActions({ id, status }: { id: string; status: string }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  async function act(action: "submit" | "post") {
    setBusy(true); setErr(null);
    const res = await fetch("/api/bills/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, documentId: id }),
    });
    const data = await res.json();
    if (!res.ok) setErr(data.error);
    setBusy(false);
    router.refresh();
  }

  return (
    <span>
      {status === "draft" && (
        <button className="btn secondary" style={{ padding: "4px 10px", fontSize: 12.5 }} disabled={busy} onClick={() => act("submit")}>
          Submit for approval
        </button>
      )}
      {status === "approved" && (
        <button className="btn" style={{ padding: "4px 10px", fontSize: 12.5 }} disabled={busy} onClick={() => act("post")}>
          Post
        </button>
      )}
      {err && <span style={{ color: "var(--danger)", fontSize: 12, marginLeft: 8 }}>{err}</span>}
    </span>
  );
}
