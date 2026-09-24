export type SandboxRefreshCadence = "hourly" | "daily" | "weekly";

/** A present invalid cadence is a malformed write, not a request to clear it. */
export function validateSandboxCadence(value: string | null): SandboxRefreshCadence | null {
  if (value === null || value === "hourly" || value === "daily" || value === "weekly") return value;
  throw new Error(`invalid sandbox refresh cadence ${JSON.stringify(value)}; choose hourly, daily, weekly, or null to clear the schedule`);
}
