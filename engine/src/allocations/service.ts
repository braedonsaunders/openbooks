import { postDriverResolver, runDriverReport } from "./report-runner.ts";
import type { ReportDriverRunner } from "./drivers.ts";
import type { DriverResolver } from "./types.ts";

/**
 * The single production composition of allocation driver dependencies
 * (finding 6.3). Report-backed drivers need the engine report runner; the
 * default bare resolver cannot run them, so every production entry point —
 * the period-run service default below, the runs preview route, the drivers
 * preview route, the scheduler, close automation — must resolve through
 * this factory instead of reconstructing the wiring. Test doubles still
 * inject through `PeriodRunDeps` / `DriverResolverDeps` directly.
 */
export function allocationServiceDeps(): {
  driverResolver: DriverResolver;
  reportRunner: ReportDriverRunner;
} {
  return {
    driverResolver: postDriverResolver,
    reportRunner: { runReport: runDriverReport },
  };
}
