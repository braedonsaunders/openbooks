"use client";

import { useState } from "react";

const STARTER = `select a.number, a.name, sum(l.amount) as balance
  from journal_lines l
  join accounts a on a.id = l.account_id
 group by 1, 2
 order by abs(sum(l.amount)) desc
 limit 15`;

export default function QueryConsole() {
  const [sqlText, setSqlText] = useState(STARTER);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    columns: string[]; rows: Record<string, unknown>[]; rowCount: number; truncated: boolean; durationMs: number;
  } | null>(null);

  async function run() {
    setBusy(true); setError(null);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sql: sqlText }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setResult(data);
    } catch (e) {
      setError((e as Error).message); setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>SQL</h1>
      <p className="sub">
        Real PostgreSQL — not a query dialect. Runs read-only under a SELECT-only role with a
        10-second timeout. Cmd/Ctrl-Enter to run.
      </p>
      <textarea
        className="sql"
        value={sqlText}
        onChange={(e) => setSqlText(e.target.value)}
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); run(); } }}
        spellCheck={false}
      />
      <p>
        <button className="btn" onClick={run} disabled={busy}>{busy ? "Running…" : "Run query"}</button>
      </p>
      {error && <pre className="error">{error}</pre>}
      {result && (
        <>
          <p className="query-meta">
            {result.rowCount} row{result.rowCount === 1 ? "" : "s"}
            {result.truncated ? " (truncated)" : ""} · {result.durationMs}ms
          </p>
          <div style={{ overflowX: "auto" }}>
            <table className="data">
              <thead>
                <tr>{result.columns.map((c) => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {result.rows.map((r, i) => (
                  <tr key={i}>
                    {result.columns.map((c) => {
                      const v = r[c];
                      const isNum = typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v);
                      return <td key={c} className={isNum ? "num" : ""}>{v === null ? <span className="muted">∅</span> : String(v)}</td>;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
