import { configuredSources } from "@openbooks/engine/src/sync/registry.ts";
import { dashboardData } from "../../lib/data";
import { dateTime } from "../../lib/format";
import { SyncButton } from "./SyncButton";

export const dynamic = "force-dynamic";

export default async function SyncPage() {
  const { runs } = await dashboardData();
  const sources = configuredSources();
  const lastOk = runs.find((r: any) => r.status === "ok");
  const mismatches = lastOk?.stats?.tb?.mismatches ?? [];

  return (
    <>
      <h1>Sync</h1>
      <p className="sub">
        Manual bridge to a connected accounting system. Each sync pulls transactions modified since
        the last run: new ones post as migration entries; changed ones are reversed and re-posted
        (full audit trail, no mutation). Every sync re-verifies the trial balance per account
        against the live source.
      </p>

      {sources.length === 0 ? (
        <div className="banner">
          No external source configured. Connect one by adding a source adapter and its
          credentials; it will appear here automatically.
        </div>
      ) : (
        <>
          <div className="section" style={{ marginTop: 0, marginBottom: 20 }}>
            <h2>Connected sources</h2>
            {sources.map((s) => (
              <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
                <span className="pill ok">{s.displayName}</span>
                <SyncButton source={s.name} label={s.displayName} />
              </div>
            ))}
          </div>
        </>
      )}

      {mismatches.length > 0 && (
        <div className="section">
          <h2>Trial-balance mismatches (last sync)</h2>
          <table className="data">
            <thead><tr><th>Source account</th><th className="num">openbooks</th><th className="num">source</th></tr></thead>
            <tbody>
              {mismatches.map((m: any) => (
                <tr key={m.accountRef}>
                  <td className="mono">{m.accountRef}</td>
                  <td className="num">{m.ours}</td>
                  <td className="num">{m.theirs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="section">
        <h2>All runs</h2>
        <table className="data">
          <thead>
            <tr><th>Started</th><th>Finished</th><th>Kind</th><th>Trigger</th><th>Status</th><th>Detail</th></tr>
          </thead>
          <tbody>
            {runs.map((r: any) => (
              <tr key={r.id}>
                <td>{dateTime(r.started_at)}</td>
                <td>{dateTime(r.finished_at)}</td>
                <td>{r.kind ?? "incremental"}</td>
                <td>{r.triggered_by}</td>
                <td><span className={`pill ${r.status}`}>{r.status}</span></td>
                <td className="muted">
                  {r.status === "ok" && r.stats
                    ? `${r.stats.newEntries} new · ${r.stats.reversedEntries} reversed · ${r.stats.unchanged} unchanged · TB ${r.stats.tb?.matches}/${r.stats.tb?.accounts}`
                    : r.error_message ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
