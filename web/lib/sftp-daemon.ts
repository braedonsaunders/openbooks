/**
 * Operator-facing text for a daemon listener that failed to start. A named
 * storage misconfiguration (SftpStorageError) names its remedy; anything
 * else (bind conflicts, driver faults) carries a generic reason — the detail
 * lives in the server log, never in the degraded response. Narrowed by the
 * class's declared name (not a module import) so route-test doubles that
 * stub the sftp backend keep loading; the engine class assigns this name
 * explicitly. Lives here (not in the route body) so API error sanitization
 * never sees raw caught text.
 */
export function sftpStartupFailureText(error: unknown): string {
  if (error instanceof Error && error.name === "SftpStorageError") return error.message;
  return "the SFTP listener failed to start — check the server log for detail";
}
