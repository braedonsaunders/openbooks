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
// ('CA', 'US', ...) inside the indirect-tax layer. Deliberately scoped to
// the tax layer rather than repo-wide: a bare two-letter literal collides
// with ordinary code ("NO" nullability checks, "IF" keywords, "RC"
// debit flags), so a repo-wide literal ban would false-positive and teach
// everyone to ignore the gate. The tax layer is held to zero; payroll's
// country handling is tracked separately (F-f7-001..F-f7-005) and its slice
// extends this gate when it lands.
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

export function isPackPath(filePath) {
  return packPaths.some((pattern) => pattern.test(filePath));
}

export function isScopedPath(filePath, roots = scopedRoots) {
  return roots.some((root) => filePath === root || filePath.startsWith(`${root}/`));
}

export function isTaxLayerPath(filePath, layer = taxLayerPaths) {
  return layer.some((pattern) => pattern.test(filePath));
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
  const layer = overrides.taxLayer ?? taxLayerPaths;
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
    if (isTaxLayerPath(filePath, layer)) {
      const countryHit = firstViolationLine(source, [countryComparison, countryCase]);
      if (countryHit) {
        violations.push(
          `${filePath}:${countryHit.lineNumber}: country branch in the indirect-tax layer (${countryHit.match.trim()})`,
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
  const violations = auditCountryNeutrality(discoverPublicFiles());

  if (violations.length > 0) {
    console.error("Country-neutrality audit failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log("Country-neutrality audit passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
