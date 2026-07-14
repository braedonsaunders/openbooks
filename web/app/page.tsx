import Link from "next/link";
import { configuredSources } from "@openbooks/engine/src/sync/registry.ts";
import { dashboardData, orgInfo } from "../lib/data";
import { dateTime, money } from "../lib/format";
import { SyncButton } from "./sync/SyncButton";

export const dynamic = "force-dynamic";

export default async function Dashboard() {
  const [{ totals, runs }, org] = await Promise.all([dashboardData(), orgInfo()]);
  const sources = configuredSources();
  const lastOk = runs.find((r: any) => r.status === "ok");
  const lastTb = lastOk?.stats?.tb;
  const lastSourceLabel = sources.find((s) => s.name === lastOk?.source)?.displayName ?? lastOk?.source;

  return (
    <>
      <h1>Dashboard</h1>
      <p className="sub">
        {org ? `${org.name} · ${org.base_currency} · ${org.book}` : "no organization configured"}
      </p>

      <div className="grid">
        <div className="card">
          <div className="label">Journal entries</div>
          <div className="value">{Number(totals.entries).toLocaleString()}</div>
        </div>
        <div className="card">
          <div className="label">Journal lines</div>
          <div className="value">{Number(totals.lines).toLocaleString()}</div>
        </div>
        <div className={`card ${Number(totals.ledger_sum) === 0 ? "good" : "bad"}`}>
          <div className="label">Ledger balance check</div>
          <div className="value small">Σ = {money(totals.ledger_sum)}</div>
        </div>
        {lastTb && (
          <div className={`card ${lastTb.mismatches?.length === 0 ? "good" : "bad"}`}>
            <div className="label">Parallel-run vs {lastSourceLabel}</div>
            <div className="value small">{lastTb.matches}/{lastTb.accounts} accounts match</div>
          </div>
        )}
      </div>

      {sources.length > 0 && (
        <>
          <div className="banner">
            An external accounting system is connected for parallel-run verification. Sync is
            manual; every sync re-verifies the trial balance per account.{" "}
            <Link href="/sync" style={{ color: "var(--accent)", fontWeight: 600 }}>Sync page →</Link>
          </div>
          <SyncButton source={sources[0].name} label={sources[0].displayName} />
        </>
      )}

      <div className="section">
        <h2>Recent sync runs</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Started</th><th>Source</th><th>Trigger</th><th>Status</th>
              <th className="num">New</th><th className="num">Reversed</th>
              <th className="num">Unchanged</th><th>TB verification</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 && (
              <tr><td colSpan={8} className="muted">No syncs yet.</td></tr>
            )}
            {runs.map((r: any) => (
              <tr key={r.id}>
                <td>{dateTime(r.started_at)}</td>
                <td>{r.source}</td>
                <td>{r.triggered_by}</td>
                <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                <td className="num">{r.stats?.newEntries ?? ""}</td>
                <td className="num">{r.stats?.reversedEntries ?? ""}</td>
                <td className="num">{r.stats?.unchanged ?? ""}</td>
                <td>
                  {r.stats?.tb ? (
                    <span className={`pill ${r.stats.tb.mismatches?.length === 0 ? "ok" : "bad"}`}>
                      {r.stats.tb.matches}/{r.stats.tb.accounts}
                    </span>
                  ) : r.error_message ? (
                    <span className="muted">{String(r.error_message).slice(0, 60)}</span>
                  ) : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
