#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const [, , actualPath, referencePath] = process.argv;

if (!actualPath || !referencePath) {
  console.error(
    "usage: node scripts/compare-schema-catalogs.mjs <actual.json> <reference.json>",
  );
  process.exit(2);
}

const actual = JSON.parse(readFileSync(actualPath, "utf8"));
const reference = JSON.parse(readFileSync(referencePath, "utf8"));

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  }
  return normalizeWhitespace(value);
}

function equal(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

function compareNamed(section, keyOf, ignoredFields = []) {
  const ignored = new Set(ignoredFields);
  const withoutIgnored = (row) =>
    Object.fromEntries(
      Object.entries(row).filter(([key]) => !ignored.has(key)),
    );
  const actualRows = new Map(actual[section].map((row) => [keyOf(row), row]));
  const referenceRows = new Map(
    reference[section].map((row) => [keyOf(row), row]),
  );
  const missing = [...referenceRows.keys()].filter(
    (key) => !actualRows.has(key),
  );
  const extra = [...actualRows.keys()].filter(
    (key) => !referenceRows.has(key),
  );
  const changed = [...referenceRows.keys()]
    .filter(
      (key) =>
        actualRows.has(key) &&
        !equal(
          withoutIgnored(actualRows.get(key)),
          withoutIgnored(referenceRows.get(key)),
        ),
    )
    .map((key) => ({
      key,
      actualDigest: digest(
        JSON.stringify(stable(withoutIgnored(actualRows.get(key)))),
      ),
      referenceDigest: digest(
        JSON.stringify(stable(withoutIgnored(referenceRows.get(key)))),
      ),
    }));
  return {
    actualCount: actualRows.size,
    referenceCount: referenceRows.size,
    missing,
    extra,
    changed,
  };
}

function constraintSignature(row) {
  return [
    row.relation,
    row.type,
    normalizeWhitespace(row.definition).replace(/ NOT VALID$/, ""),
  ].join("|");
}

function countsBy(rows, keyOf) {
  const counts = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

const actualConstraintCounts = countsBy(
  actual.constraints,
  constraintSignature,
);
const referenceConstraintCounts = countsBy(
  reference.constraints,
  constraintSignature,
);
const constraintSignatures = new Set([
  ...actualConstraintCounts.keys(),
  ...referenceConstraintCounts.keys(),
]);

const constraintSemantic = {
  actualSignatureCount: actualConstraintCounts.size,
  referenceSignatureCount: referenceConstraintCounts.size,
  missing: [...constraintSignatures].filter(
    (key) => !actualConstraintCounts.has(key),
  ),
  extra: [...constraintSignatures].filter(
    (key) => !referenceConstraintCounts.has(key),
  ),
  multiplicityDifferences: [...constraintSignatures]
    .filter(
      (key) =>
        (actualConstraintCounts.get(key) ?? 0) !==
        (referenceConstraintCounts.get(key) ?? 0),
    )
    .map((key) => ({
      signature: key,
      actual: actualConstraintCounts.get(key) ?? 0,
      reference: referenceConstraintCounts.get(key) ?? 0,
    })),
};

const actualConstraintsByName = new Map(
  actual.constraints.map((row) => [
    `${row.relation}|${row.constraint}`,
    row,
  ]),
);
const referenceConstraintsByName = new Map(
  reference.constraints.map((row) => [
    `${row.relation}|${row.constraint}`,
    row,
  ]),
);
const validationDifferences = [...referenceConstraintsByName]
  .filter(
    ([key, row]) =>
      actualConstraintsByName.has(key) &&
      actualConstraintsByName.get(key).validated !== row.validated,
  )
  .map(([key, row]) => ({
    key,
    actual: actualConstraintsByName.get(key).validated,
    reference: row.validated,
  }));

const report = {
  actualPath,
  referencePath,
  relations: compareNamed("relations", (row) => row.relation),
  columns: compareNamed(
    "columns",
    (row) => `${row.relation}|${row.column}`,
    ["position"],
  ),
  constraints: {
    semantic: constraintSemantic,
    validationDifferences,
  },
  indexes: compareNamed(
    "indexes",
    (row) => `${row.table_name}|${row.index}`,
  ),
  triggers: compareNamed(
    "triggers",
    (row) => `${row.relation}|${row.trigger}`,
  ),
  functions: compareNamed(
    "functions",
    (row) => `${row.function}|${row.arguments}`,
  ),
  policies: compareNamed(
    "policies",
    (row) => `${row.tablename}|${row.policyname}`,
  ),
};

report.equivalent =
  report.relations.missing.length === 0 &&
  report.relations.extra.length === 0 &&
  report.relations.changed.length === 0 &&
  report.columns.missing.length === 0 &&
  report.columns.extra.length === 0 &&
  report.columns.changed.length === 0 &&
  report.constraints.semantic.missing.length === 0 &&
  report.constraints.semantic.extra.length === 0 &&
  report.constraints.semantic.multiplicityDifferences.length === 0 &&
  report.constraints.validationDifferences.length === 0 &&
  report.indexes.missing.length === 0 &&
  report.indexes.extra.length === 0 &&
  report.indexes.changed.length === 0 &&
  report.triggers.missing.length === 0 &&
  report.triggers.extra.length === 0 &&
  report.triggers.changed.length === 0 &&
  report.functions.missing.length === 0 &&
  report.functions.extra.length === 0 &&
  report.functions.changed.length === 0 &&
  report.policies.missing.length === 0 &&
  report.policies.extra.length === 0 &&
  report.policies.changed.length === 0;

console.log(JSON.stringify(report, null, 2));
