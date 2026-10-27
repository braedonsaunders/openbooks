import type { PendingSandboxCreate } from "@openbooks/jobs";
import type { SandboxRow } from "./SandboxManager";

/**
 * A create is visible from the moment it is queued. The worker writes the
 * sandbox row when the clone starts; until then the queued job stands in for
 * it. A running job whose row already exists is shown by that row alone.
 */
export function queuedSandboxRows(
  pending: readonly PendingSandboxCreate[],
  rows: readonly SandboxRow[],
): SandboxRow[] {
  return pending
    .filter(
      (job) =>
        job.state === "queued" ||
        !rows.some((row) => row.name === job.name && row.status === "provisioning"),
    )
    .map((job) => ({
      id: `queued:${job.jobId}`,
      orgId: "",
      name: job.name,
      tier: job.tier,
      masked: job.masked,
      status: job.state === "queued" ? "queued" : "provisioning",
      lastError: null,
      lastRefreshAt: null,
      refreshSchedule: null,
      storageRows: 0,
      createdAt: job.queuedAt,
    }));
}
