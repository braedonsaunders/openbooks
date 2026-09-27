import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { STANDARD_STATEMENT_DEFINITIONS, validateCustomQuery } from "@openbooks/reports";
import { SEEDED_CATALOG_REPORTS } from "./catalog-reports.ts";

describe("seeded report catalog", () => {
  it("validates every plan and keeps slugs unique", () => {
    const invalid: string[] = [];
    for (const def of SEEDED_CATALOG_REPORTS) {
      try {
        validateCustomQuery(def.query);
      } catch (error) {
        invalid.push(`${def.slug}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assert.deepEqual(invalid, [], `Invalid report plans: ${invalid.join("; ")}`);
    const slugs = [...SEEDED_CATALOG_REPORTS, ...STANDARD_STATEMENT_DEFINITIONS].map(({ slug }) => slug);
    const duplicates = slugs.filter((slug, index) => slugs.indexOf(slug) !== index);
    assert.deepEqual([...new Set(duplicates)], [], `Duplicate seeded report slugs: ${duplicates.join(", ")}`);
  });
});
