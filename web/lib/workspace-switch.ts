/**
 * Client side of a workspace switch. The switch goes through the stable
 * POST /api/me/workspace endpoint and then loads a fresh document, so:
 *
 * - a tab rendered by an earlier deployment can still switch (a server action
 *   from that build would be unknown to the current server);
 * - no client state from the previous workspace survives: router cache,
 *   drawers, list caches and in-memory drafts all belong to the workspace that
 *   rendered them.
 *
 * Other open tabs learn of the switch on WORKSPACE_CHANNEL and through the
 * session check in WorkspaceSync.
 */

export const WORKSPACE_CHANNEL = "openbooks-workspace";

export type WorkspaceSwitchRefusal = "invalid_workspace" | "workspace_unavailable" | "failed";

let switching = false;

/** True once this tab has switched and is loading the new workspace. */
export function isSwitchingWorkspace(): boolean {
  return switching;
}

export class WorkspaceSwitchError extends Error {
  constructor(
    readonly refusal: WorkspaceSwitchRefusal,
    readonly status: number,
  ) {
    super(`Workspace switch refused (${status} ${refusal})`);
    this.name = "WorkspaceSwitchError";
  }
}

/** The shell.accountMenu message that explains a failed switch to the operator. */
export function workspaceSwitchMessageKey(error: unknown): "switchUnavailable" | "switchFailed" {
  return error instanceof WorkspaceSwitchError && error.refusal === "workspace_unavailable"
    ? "switchUnavailable"
    : "switchFailed";
}

/** Same-origin, single-slash paths only; anything else lands on the home page. */
export function safeWorkspaceReturnTo(returnTo: string): string {
  return returnTo.startsWith("/") && !returnTo.startsWith("//") && !/[\\\r\n]/.test(returnTo)
    ? returnTo
    : "/";
}

/** A workspace boundary discards the entire document and its previous tenant's client state. */
export function reloadWorkspaceDocument(returnTo?: string): void {
  if (returnTo === undefined) window.location.reload();
  else window.location.assign(safeWorkspaceReturnTo(returnTo));
}

export async function switchWorkspace(orgId: string, returnTo = "/"): Promise<void> {
  const response = await fetch("/api/me/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orgId }),
    cache: "no-store",
  });
  if (!response.ok) {
    let refusal: WorkspaceSwitchRefusal = "failed";
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
    if (body?.error === "invalid_workspace" || body?.error === "workspace_unavailable")
      refusal = body.error;
    throw new WorkspaceSwitchError(refusal, response.status);
  }
  const switched = (await response.json()) as { orgId: string };
  switching = true;
  announceWorkspace(switched.orgId);
  reloadWorkspaceDocument(returnTo);
}

function announceWorkspace(orgId: string): void {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(WORKSPACE_CHANNEL);
  channel.postMessage({ orgId });
  channel.close();
}
