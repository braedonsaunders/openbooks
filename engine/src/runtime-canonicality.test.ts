import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("normal connector execution never performs schema migration", () => {
  const migrationLoader = source("engine/src/sync/migrate.ts");
  assert.doesNotMatch(migrationLoader, /\b(?:alter|create|drop)\s+(?:table|index)\b/i);
  assert.doesNotMatch(migrationLoader, /ensureSchema\s*\(/);
});

test("normal mirror and project revenue execution never repairs historical rows", () => {
  const mirror = source("engine/src/sync/sync.ts");
  const projectRevenue = source("engine/src/project-revenue.ts");
  assert.doesNotMatch(mirror, /update\s+document_lines[\s\S]{0,300}tax_code_id\s*=\s*null/i);
  assert.doesNotMatch(projectRevenue, /backfillHistoricalRecognition/);
  assert.doesNotMatch(projectRevenue, /insert\s+into\s+recognition_schedule_lines/i);
});

test("accounting write paths do not invent a product-default currency", () => {
  for (const path of [
    "engine/src/journal-writes.ts",
    "engine/src/ap-capture-service.ts",
    "engine/src/project-recognition.ts",
    "engine/src/project-revenue.ts",
    "engine/src/sync/migrate.ts",
  ]) {
    assert.doesNotMatch(source(path), /(?:\?\?|\|\|)\s*["'](?:CAD|USD)["']/, `${path} invents a default currency`);
  }
});
