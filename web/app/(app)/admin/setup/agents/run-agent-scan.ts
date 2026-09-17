/**
 * Shared run-now POST for the Agents islands (overview pack actions, activity
 * re-run): one endpoint, one outcome shape, so a rejected run explains
 * itself the same way everywhere. A 409 `claimed_elsewhere` means another
 * run — an earlier click, another tab, the scheduler — already owns the
 * scan; the islands answer that with an "already running" toast and a
 * refresh (the row converges onto the winner's progress) instead of a
 * generic failure.
 */
export type AgentScanOutcome = { ok: true; detected: number } | { ok: false; alreadyRunning: boolean };

export async function postAgentScan(agentKey: string): Promise<AgentScanOutcome> {
  const res = await fetch(`/api/admin/setup/agents/${agentKey}/run`, { method: 'POST' })
  const payload = (await res.json().catch(() => ({}))) as { detected?: number; status?: string }
  if (res.ok) return { ok: true, detected: payload.detected ?? 0 }
  return { ok: false, alreadyRunning: res.status === 409 && payload.status === 'claimed_elsewhere' }
}
