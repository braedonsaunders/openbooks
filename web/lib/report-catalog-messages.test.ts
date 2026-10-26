import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { allReportEntities, BUILT_IN_REPORT_DEFINITIONS } from "@openbooks/reports";
import { NONPROFIT_REPORTS } from "@openbooks/engine/testing/reports/catalog-reports";
import "./resourcing/report-facts.ts";
import { reportEnumLabel } from "./report-enum-label.ts";

/**
 * Every report entity and every one of its columns must have a heading.
 *
 * `reportRunLabels` (web/lib/report-labels.ts) resolves column headings with a
 * bare `t(\`catalog.columns.${entity}.${column}\`)` — no `t.has` guard and no
 * fallback — so a missing key renders the key PATH as the column heading, in
 * the report, in exports, and in the scheduled PDF. It is silent: nothing
 * throws, nothing logs, and it is only caught by someone opening that specific
 * report and reading the header row.
 *
 * Adding an entity or a column is therefore a two-file change, and this is what
 * says so at the point the second file is forgotten.
 */

const LOCALES = ["de", "en", "es", "fr", "ja", "pt-BR", "zh"] as const;
type ReportsCatalog = {
  builtIns: Record<string, { name?: string; description?: string }>;
  catalog: {
    entities: Record<string, unknown>;
    columns: Record<string, Record<string, string>>;
    enumValues: Record<string, string>;
    columnValues?: Record<string, Record<string, Record<string, string>>>;
  };
};

const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "messages", locale, "reports.json"), "utf8"),
    ) as ReportsCatalog,
  ]),
) as Record<(typeof LOCALES)[number], ReportsCatalog>;
const reportEntities = allReportEntities().map(({ entity }) => entity);

test("every report entity has a catalog label", () => {
  assert.ok(reportEntities.length > 0, "no report entities were loaded — the import broke");
  const missing: string[] = [];
  for (const locale of LOCALES) {
    for (const entity of reportEntities) {
      const entry = catalogs[locale].catalog.entities[entity.key] as
        { label?: unknown; description?: unknown } | undefined;
      for (const field of ["label", "description"] as const) {
        if (typeof entry?.[field] !== "string" || !(entry[field] as string).trim()) {
          missing.push(`${locale}:catalog.entities.${entity.key}.${field}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `entities with no label:\n${missing.join("\n")}`);
});

test("every built-in report definition has a localized title and description, or its runs, PDFs and exports print the key path", () => {
  // The runner titles a built-in run with a bare t(`builtIns.<slug>.name`)
  // (web/lib/report-run.ts), so the seeded catalog (package built-ins and
  // the nonprofit board reports) must be named in every locale.
  const definitions = [...BUILT_IN_REPORT_DEFINITIONS, ...NONPROFIT_REPORTS];
  assert.ok(definitions.length > 100, "the built-in registry loaded");
  const missing: string[] = [];
  for (const locale of LOCALES) {
    for (const definition of definitions) {
      const entry = catalogs[locale].builtIns[definition.slug];
      for (const field of ["name", "description"] as const) {
        if (typeof entry?.[field] !== "string" || !entry[field]!.trim())
          missing.push(`${locale}:builtIns.${definition.slug}.${field}`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `built-in reports with no localized title or description:\n${missing.join("\n")}`,
  );
});

test("every report column has a heading, or the report renders its key path", () => {
  const missing: string[] = [];
  for (const locale of LOCALES) {
    for (const entity of reportEntities) {
      const headings = catalogs[locale].catalog.columns[entity.key] ?? {};
      for (const column of entity.columns ?? []) {
        if (typeof headings[column.key] !== "string" || !headings[column.key]!.trim()) {
          missing.push(`${locale}:catalog.columns.${entity.key}.${column.key}`);
        }
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `these would render as raw key paths in the column header:\n${missing.join("\n")}`,
  );
});

test("source-specific enum labels name real enum options and cover every equity enum in every locale", () => {
  const problems: string[] = [];
  const equityEnums = reportEntities
    .filter((entity) => entity.featureKey === "equity")
    .flatMap((entity) =>
      (entity.columns ?? [])
        .filter((column) => column.kind === "enum")
        .map((column) => ({ entity, column })),
    );
  assert.ok(equityEnums.length >= 5, "the equity sources declare their enum columns");
  for (const locale of LOCALES) {
    const scoped = catalogs[locale].catalog.columnValues ?? {};
    for (const [entityKey, columns] of Object.entries(scoped)) {
      const entity = reportEntities.find((candidate) => candidate.key === entityKey);
      for (const [columnKey, values] of Object.entries(columns)) {
        const column = entity?.columns?.find((candidate) => candidate.key === columnKey);
        for (const [value, label] of Object.entries(values)) {
          if (!column?.options?.includes(value))
            problems.push(
              `${locale}: ${entityKey}.${columnKey}.${value} is not an option of that column`,
            );
          if (!label.trim())
            problems.push(`${locale}: ${entityKey}.${columnKey}.${value} is blank`);
        }
      }
    }
    for (const { entity, column } of equityEnums) {
      for (const option of column.options ?? []) {
        if (!scoped[entity.key]?.[column.key]?.[option])
          problems.push(`${locale}: ${entity.key}.${column.key}.${option} has no label`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

test("an enum value reads with its source column label first, then the shared label, else falls back", () => {
  const messages = catalogs.de;
  const lookup = (key: string): string | undefined =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        messages,
      ) as string | undefined;
  const t = Object.assign((key: string) => lookup(key) ?? key, {
    has: (key: string) => typeof lookup(key) === "string",
  });
  assert.equal(
    reportEnumLabel(t, "note", { entity: "equity_securities_register", column: "security_kind" }),
    "Wandeldarlehen",
  );
  assert.equal(
    reportEnumLabel(t, "pool", { entity: "equity_cap_table_positions", column: "position_kind" }),
    "Nicht zugeteilter Pool",
  );
  assert.equal(
    reportEnumLabel(t, "posted", { entity: "equity_securities_register", column: "security_kind" }),
    messages.catalog.enumValues.posted,
  );
  assert.equal(reportEnumLabel(t, "not_a_value"), null);
});
