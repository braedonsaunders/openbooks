/**
 * Mutation-score ratchet.
 *
 * `mutation-floor.json` records the ratified killed-ratio per target;
 * `mutation-report.json` is the last ratified measurement. This test fails
 * when any measured target scores below its floor, when the harness stops
 * measuring a target it should measure (zero-mutant or missing entries, or
 * a red baseline), or when config/report/floor drift apart. Raise floors by
 * re-running `npm run test:mutation -- --write-checked-in`, verifying the
 * new report, and committing the updated report + floor together — the
 * coordinator decides when a higher floor is ratified.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadMutationConfig } from "./config.ts";
import type { CheckedInReport } from "./cli.ts";

const DIR = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

interface FloorFile {
  readonly version: 1;
  readonly floors: Record<string, { readonly ratio: number; readonly measured: number; readonly mode: string }>;
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(`${DIR}/${name}`, "utf8")) as T;
}

test("mutation scores hold above the floor and every target is measured", () => {
  const config = loadMutationConfig();
  const report = readJson<CheckedInReport>("mutation-report.json");
  const floor = readJson<FloorFile>("mutation-floor.json");

  assert.equal(report.version, 1);
  assert.equal(floor.version, 1);
  const configPaths = new Set(config.targets.map((t) => t.path));
  const reportByTarget = new Map(report.targets.map((t) => [t.target, t]));

  // No silent scope loss: every configured target appears in the report.
  for (const path of configPaths) {
    assert.ok(reportByTarget.has(path), `report is missing configured target ${path} — re-run test:mutation`);
  }
  // No stale floors or phantom report entries.
  for (const path of Object.keys(floor.floors)) {
    assert.ok(configPaths.has(path), `floor references unconfigured target ${path}`);
  }
  for (const path of reportByTarget.keys()) {
    assert.ok(configPaths.has(path), `report references unconfigured target ${path}`);
  }

  for (const target of config.targets) {
    const entry = reportByTarget.get(target.path)!;
    assert.notEqual(entry.status, "baseline-failed", `${target.path}: baseline failed — the harness cannot measure it`);
    assert.notEqual(entry.status, "no-mutants", `${target.path}: zero mutants generated — operators cover nothing`);
    if (entry.measured > 0) {
      assert.ok(entry.ratio !== null && entry.ratio >= 0 && entry.ratio <= 1, `${target.path}: malformed ratio`);
      const floorEntry = floor.floors[target.path];
      if (floorEntry) {
        assert.ok(
          (entry.ratio ?? 0) + 1e-9 >= floorEntry.ratio,
          `${target.path}: score ${(entry.ratio ?? 0).toFixed(3)} below floor ${floorEntry.ratio.toFixed(3)}`,
        );
      }
    } else {
      // Unmeasured is only honest for DB-only targets in a unit-mode report.
      const excused = target.needsDb === true && report.mode === "unit";
      assert.ok(
        excused,
        `${target.path}: nothing measured (status ${entry.status}) — re-run test:mutation with a database`,
      );
    }
  }
});
