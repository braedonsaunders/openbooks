import { unstable_isUnrecognizedActionError } from "next/navigation";

/**
 * True when the failure means this tab is running an earlier deployment: the
 * server no longer recognizes the tab's server action, or a code chunk the tab
 * expects is gone. Retrying re-renders the same stale page, so error
 * boundaries offer a full reload instead.
 */
export function isStaleDeploymentError(error: unknown): boolean {
  if (unstable_isUnrecognizedActionError(error)) return true;
  return (
    error instanceof Error &&
    (error.name === "UnrecognizedActionError" || error.name === "ChunkLoadError")
  );
}
