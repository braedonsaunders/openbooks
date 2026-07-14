"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Opt { id: string; display_name?: string; number?: string; name?: string; code?: string }
interface Line { accountId: string; description: string; amount: string; taxCodeId: string }

const input = { padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 7, background: "var(--surface)", font: "inherit" } as const;

export function BillForm({ vendors, accounts, taxCodes }: { vendors: Opt[]; accounts: Opt[]; taxCodes: Opt[] }) {
  const today = new Date().toISOString().slice(0, 10);
  const [partyId, setPartyId] = useState("");
  const [documentDate, setDocumentDate] = useState(today);
  const [dueDate, setDueDate] = useState("");
  const [referenceNumber, setReferenceNumber] = useState("");
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([{ accountId: "", description: "", amount: "", taxCodeId: "" }]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const router = useRouter();

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  const subtotal = lines.reduce((a, l) => a + (Number(l.amount) || 0), 0);

  async function save() {
    setBusy(true); setErr(null);
    const res = await fetch("/api/bills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        partyId, documentDate, dueDate: dueDate || undefined, referenceNumber, memo,
        lines: lines.filter((l) => l.accountId && Number(l.amount) > 0)
          .map((l) => ({ ...l, taxCodeId: l.taxCodeId || undefined })),
      }),
    });
    const data = await res.json();
    if (!res.ok) { setErr(data.error); setBusy(false); return; }
    router.push("/ap");
    router.refresh();
  }

  return (
    <div className="card" style={{ maxWidth: 900 }}>
      <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr", gap: 12, marginBottom: 14 }}>
        <label>Vendor<br />
          <select style={{ ...input, width: "100%" }} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">— select vendor —</option>
            {vendors.map((v) => <option key={v.id} value={v.id}>{v.display_name}</option>)}
          </select>
        </label>
        <label>Bill date<br /><input type="date" style={{ ...input, width: "100%" }} value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} /></label>
        <label>Due date<br /><input type="date" style={{ ...input, width: "100%" }} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>
        <label>Vendor ref #<br /><input style={{ ...input, width: "100%" }} value={referenceNumber} onChange={(e) => setReferenceNumber(e.target.value)} /></label>
      </div>

      <table className="data" style={{ marginBottom: 12 }}>
        <thead><tr><th>Account</th><th>Description</th><th style={{ width: 130 }}>Amount</th><th style={{ width: 140 }}>Tax</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <select style={{ ...input, width: "100%" }} value={l.accountId} onChange={(e) => setLine(i, { accountId: e.target.value })}>
                  <option value="">— account —</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
                </select>
              </td>
              <td><input style={{ ...input, width: "100%" }} value={l.description} onChange={(e) => setLine(i, { description: e.target.value })} /></td>
              <td><input style={{ ...input, width: "100%", textAlign: "right" }} inputMode="decimal" value={l.amount} onChange={(e) => setLine(i, { amount: e.target.value })} /></td>
              <td>
                <select style={{ ...input, width: "100%" }} value={l.taxCodeId} onChange={(e) => setLine(i, { taxCodeId: e.target.value })}>
                  <option value="">no tax</option>
                  {taxCodes.map((t) => <option key={t.id} value={t.id}>{t.code}</option>)}
                </select>
              </td>
              <td>
                {lines.length > 1 && (
                  <button className="btn secondary" style={{ padding: "4px 9px" }} onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>✕</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button className="btn secondary" onClick={() => setLines((ls) => [...ls, { accountId: "", description: "", amount: "", taxCodeId: "" }])}>
          + Add line
        </button>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <span className="muted">Subtotal (pre-tax): <strong>{subtotal.toLocaleString("en-CA", { minimumFractionDigits: 2 })}</strong></span>
          <button className="btn" disabled={busy || !partyId} onClick={save}>{busy ? "Saving…" : "Save draft"}</button>
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        <input placeholder="Memo" style={{ ...input, width: "100%" }} value={memo} onChange={(e) => setMemo(e.target.value)} />
      </div>
      {err && <p style={{ color: "var(--danger)" }}>{err}</p>}
    </div>
  );
}
