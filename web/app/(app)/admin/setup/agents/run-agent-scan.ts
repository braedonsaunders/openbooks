import { readApiErrorMessage } from '../../../../../lib/api-error'

/**
 * Shared run-now POST for the Agents islands (overview pack actions, activity
 * re-run): one endpoint, one outcome shape, so a rejected run explains
 * itself the same way everywhere. A 409 `claimed_elsewhere` means another
 * run — an earlier click, another tab, the scheduler — already owns the
 * scan; the islands answer that with an "already running" toast and a
 * refresh (the row converges onto the winner's progress) instead of a
 * generic failure.
 */
export type AgentScanOutcome =
  | { ok: true; detected: number }
  | { ok: false; alreadyRunning: boolean; code: string | null; error: string | null };

export async function postAgentScan(agentKey: string, failedMessage: string): Promise<AgentScanOutcome> {
  const res = await fetch(`/api/admin/setup/agents/${agentKey}/run`, { method: 'POST' })
  if (res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { detected?: number }
    return { ok: true, detected: payload.detected ?? 0 }
  }
  const payload = (await res.clone().json().catch(() => ({}))) as { error?: unknown; status?: string }
  return {
    ok: false,
    alreadyRunning: res.status === 409 && payload.status === 'claimed_elsewhere',
    code: typeof payload.error === 'string' ? payload.error : null,
    error: await readApiErrorMessage(res, failedMessage),
  }
}
