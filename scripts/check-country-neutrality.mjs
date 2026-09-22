import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Country-neutrality gate (F-w4-001): country packs DECLARE, the generic
// layer branches on NOTHING. Two rules:
//
// Rule 1 — no equality branch against a pack form code (CA_GST34, US_941,
// ...) anywhere in generic product source. The generic tax prepare panel
// once read `code === 'CA_GST34'` to show a filing notice; every future
// jurisdiction with a filing caveat would have added another branch there.
// Form codes may appear as data (pack declarations, registries keyed by
// code, fixtures naming the pack under test) but never as a comparison.
//
// Rule 2 — no equality branch against a bare two-letter country literal
// ('CA', 'US', ...) inside the generic country-branching layer: the
// indirect-tax layer AND the shared payroll layer. Deliberately scoped to
// those layers rather than repo-wide: a bare two-letter literal collides with
// ordinary code ("NO" nullability checks, "IF" keywords, "RC" debit flags), so
// a repo-wide literal ban would false-positive and teach everyone to ignore
// the gate.
//
// The payroll shared layer is a file DIRECTLY under engine/src/payroll/ (no
// subdirectory) plus web/app/api/payroll/**. A payroll country pack — every
// direct subdirectory of engine/src/payroll/ (au, br, canada, de, ...) — may
// name its own country: that is what a pack declaring rather than the generic
// layer branching means. The line is structural, so a new pack directory is
// exempt without an edit; a generic subdirectory added under engine/src/payroll
// would be a deliberate decision (it would be treated as a pack), not silence.
//
// No shared-layer site names a country: PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS
// is empty and the ratchet keeps it so. The list may only shrink — a stale
// entry (a path that no longer names a country) fails the gate.
//
// What the gate does NOT cover, by decision: SQL migrations (data history
// legitimately names forms — 0147 healed CA_GST34 rows by code), `??`/`||`
// fallthrough defaults, and per-country UI copy in locale catalogs.

const FORM_CODE = "[A-Z]{2}_[A-Z0-9]+";
const COUNTRY_CODE = "[A-Z]{2}";

const formCodeComparison = new RegExp(
  `(===|!==)\\s*['"](${FORM_CODE})['"]|['"](${FORM_CODE})['"]\\s*(===|!==)`,
);
const formCodeCase = new RegExp(`case\\s*['"](${FORM_CODE})['"]\\s*:`);
const countryComparison = new RegExp(
  `(===|!==)\\s*['"](${COUNTRY_CODE})['"]|['"](${COUNTRY_CODE})['"]\\s*(===|!==)`,
);
const countryCase = new RegExp(`case\\s*['"](${COUNTRY_CODE})['"]\\s*:`);

const executableSourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const fixtureSourcePattern =
  /(?:^|\/)(?:__tests__|fixtures?|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

// Country packs declare; conformance cases name the pack they verify.
const packPaths = [
  /^engine\/src\/country-tax-packs\//,
  /^engine\/src\/conformance\//,
];

const scopedRoots = ["web/app", "web/lib", "web/components", "engine/src", "packages", "schema/src"];

// The indirect-tax layer, held to zero country branches (Rule 2).
const taxLayerPaths = [
  /^web\/app\/\(app\)\/tax\//,
  /^web\/app\/api\/tax\//,
  /^engine\/src\/tax\/seed-tax-forms\.ts$/,
  /^engine\/src\/tax-returns\/return\.ts$/,
  /^engine\/src\/tax\/pack-provisioning\.ts$/,
];

// The shared payroll layer (Rule 2): files DIRECTLY under engine/src/payroll/
// (a subdirectory is a country pack and may name its own country) plus the
// payroll API routes.
const payrollSharedLayerPaths = [
  /^engine\/src\/payroll\/[^/]+\.ts$/,
  /^web\/app\/api\/payroll\//,
];

// Rule 2 applies to the tax layer and the shared payroll layer together.
const countryLiteralLayerPaths = [...taxLayerPaths, ...payrollSharedLayerPaths];

/**
 * Shared-payroll sites that still name a country. Keyed by path; the list may
 * only SHRINK — a stale entry (a path that no longer names a country) fails
 * the gate, so an amnesty cannot outlive the fix it was granted for.
 */
export const PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS = [
  // EMPTY, and the ratchet below keeps it that way. The six F-f7 sites that
  // lived here are gone: rl1/rl1xml moved to canada/quebec/, t4xml/roexml to
  // canada/ (the form IS the jurisdiction, so the structural rule exempts
  // them without an entry), and remittance.ts, yearend.ts and the year-end
  // file route now read pack DECLARATIONS — remittanceRegionalCalendars,
  // QPIP_PROVINCE, and the filing's own `issue` block — instead of comparing
  // against a country. An entry added here must name its removal plan.
]

export function isPackPath(filePath) {
  return packPaths.some((pattern) => pattern.test(filePath));
}

export function isScopedPath(filePath, roots = scopedRoots) {
  return roots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

export function isTaxLayerPath(filePath, layer = taxLayerPaths) {
  return layer.some((pattern) => pattern.test(filePath));
}

/** The full Rule 2 scope: the indirect-tax layer plus the shared payroll layer. */
export function isCountryLiteralLayerPath(filePath, layer = countryLiteralLayerPaths) {
  return layer.some((pattern) => pattern.test(filePath));
}

const EXEMPT_PAYROLL_LITERAL_PATHS = new Set(
  PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS.map((entry) => entry.path),
);

/** True when `filePath` names a country in the Rule 2 scope but is a known F-f7 exemption. */
export function isExemptPayrollCountryLiteral(filePath) {
  return EXEMPT_PAYROLL_LITERAL_PATHS.has(filePath);
}

/**
 * Exemption paths that no longer name a country — the ratchet. A path listed
 * but clean means the fix landed and the entry must be removed; returning it
 * fails the gate rather than letting the list rot into permanent amnesty.
 */
export function staleCountryLiteralExemptions(
  files,
  readSource = (file) => readFileSync(file, "utf8"),
  entries = PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS,
) {
  const present = new Set(files);
  const stale = [];
  for (const entry of entries) {
    if (!present.has(entry.path)) {
      stale.push(`${entry.path}: listed exemption is not a tracked file`);
      continue;
    }
    let source;
    try {
      source = readSource(entry.path);
    } catch {
      stale.push(`${entry.path}: listed exemption could not be read`);
      continue;
    }
    if (!firstViolationLine(source, [countryComparison, countryCase])) {
      stale.push(`${entry.path}: no longer names a country — remove it from PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS`);
    }
  }
  return stale;
}

function firstViolationLine(source, patterns) {
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match) return { lineNumber: index + 1, match: match[0] };
    }
  }
  return null;
}

/**
 * Audit candidate files and return every country-neutrality violation as a
 * human-readable line. Exported so the gate's policy is testable without a
 * git fixture (same shape as check-product-neutrality.mjs).
 */
export function auditCountryNeutrality(publicFiles, overrides = {}) {
  const roots = overrides.roots ?? scopedRoots;
  const layer = overrides.taxLayer ?? countryLiteralLayerPaths;
  const violations = [];

  for (const filePath of publicFiles) {
    if (!executableSourcePattern.test(filePath)) continue;
    if (fixtureSourcePattern.test(filePath)) continue;
    if (!isScopedPath(filePath, roots)) continue;
    if (isPackPath(filePath)) continue;

    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (source.includes("\0")) continue;

    const formHit = firstViolationLine(source, [formCodeComparison, formCodeCase]);
    if (formHit) {
      violations.push(
        `${filePath}:${formHit.lineNumber}: pack form-code branch outside packs and fixtures (${formHit.match.trim()})`,
      );
      continue;
    }
    if (isCountryLiteralLayerPath(filePath, layer) && !isExemptPayrollCountryLiteral(filePath)) {
      const countryHit = firstViolationLine(source, [countryComparison, countryCase]);
      if (countryHit) {
        violations.push(
          `${filePath}:${countryHit.lineNumber}: country branch in the generic country-branching layer (${countryHit.match.trim()})`,
        );
      }
    }
  }

  return violations;
}

function discoverPublicFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function main() {
  const files = discoverPublicFiles();
  const violations = auditCountryNeutrality(files);
  const stale = staleCountryLiteralExemptions(files);

  if (violations.length > 0 || stale.length > 0) {
    console.error("Country-neutrality audit failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    for (const entry of stale) console.error(`- ${entry}`);
    process.exit(1);
  }

  console.log(
    `Country-neutrality audit passed (${PAYROLL_SHARED_COUNTRY_LITERAL_EXEMPTIONS.length} `
      + "shared-payroll exemption(s) tracked for F-f7).",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
