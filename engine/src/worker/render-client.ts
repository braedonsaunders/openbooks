/**
 * The worker renders report PDFs by calling the web app's internal render
 * endpoint (rendering lives in web/lib, which the engine can't import). Auth is
 * a shared internal token; the endpoint takes orgId + definitionId explicitly
 * since the worker has no user session.
 */
export function appBaseUrl(): string {
  return process.env.OPENBOOKS_INTERNAL_URL
    || process.env.OPENBOOKS_APP_URL
    || "http://localhost:4780";
}

export async function renderReportPdf(
  orgId: string,
  definitionId: string,
  params: Record<string, string> = {},
): Promise<Buffer> {
  const token = process.env.OPENBOOKS_INTERNAL_TOKEN || "";
  const qs = new URLSearchParams({ orgId, definitionId, ...params });
  const res = await fetch(`${appBaseUrl()}/api/internal/reports/render?${qs.toString()}`, {
    redirect: "error",
    headers: { "x-internal-token": token },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`report render failed: HTTP ${res.status} ${detail}`.slice(0, 300));
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Recheck the persisted run principal immediately before external delivery. */
export async function authorizeReportRun(orgId: string, definitionId: string, runId: string): Promise<void> {
  const qs = new URLSearchParams({ orgId, definitionId, runId, authorizeOnly: '1' });
  const response = await fetch(`${appBaseUrl()}/api/internal/reports/render?${qs}`, {
    redirect: 'error',
    headers: { 'x-internal-token': process.env.OPENBOOKS_INTERNAL_TOKEN || '' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Report delivery authorization failed: HTTP ${response.status}`);
}
