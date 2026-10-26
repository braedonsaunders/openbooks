import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { containsPrivateIdentifier, loadPrivateFingerprints } from "./private-identifiers.mjs";

const joined = (...parts) => parts.join("");

const vendorPatterns = [
  new RegExp(joined("Net", "Suite"), "i"),
  new RegExp(joined("Quick", "Books"), "i"),
  new RegExp(`\\b${joined("Q", "BO")}\\b`),
  new RegExp(`\\b${joined("Q", "BD")}\\b`),
  new RegExp(`\\b${joined("Xe", "ro")}\\b`, "i"),
  new RegExp(`\\b${joined("Od", "oo")}\\b`, "i"),
  new RegExp(joined("ERP", "Next"), "i"),
  new RegExp(joined("Sage ", "Intacct"), "i"),
  new RegExp(joined("Microsoft ", "Dynamics(?: 365)?"), "i"),
  new RegExp(joined("Dynamics ", "365"), "i"),
  new RegExp(joined("Oracle ", "Financials"), "i"),
  new RegExp(`\\b${joined("S", "AP")}\\b`),
  new RegExp(joined("Suite", "Analytics"), "i"),
  new RegExp(joined("Suite", "Flow"), "i"),
  new RegExp(joined("Suite", "Script"), "i"),
  new RegExp(joined("Suite", "App"), "i"),
  new RegExp(joined("Suite", "QL"), "i"),
  new RegExp(joined("One", "World"), "i"),
];

// Customer, tenant and account identifiers are matched by fingerprint, loaded
// from outside the repository (see private-identifiers.mjs).
const privateFingerprints = loadPrivateFingerprints();

const privatePathPatterns = [
  /(?:^|\/)\.local\/tenant-migrations(?:\/|$)/i,
  /(?:^|\/)account-data(?:\/|$)/i,
  /(?:^|\/)extraction(?:\/|$)/i,
  /(?:^|\/)objects-list\.txt$/i,
];

// Executable operator helpers must never carry a workstation's resolved tenant
// or actor identity into the public product. Tests and fixtures may use stable
// UUIDs, but runnable source must resolve its target from explicit arguments or
// environment input and keep tenant-specific repair/setup scripts private.
const executableSourcePattern = /\.(?:[cm]?[jt]sx?)$/i;
const fixtureSourcePattern =
  /(?:^|\/)(?:__tests__|fixtures?|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const hardcodedOperatorIdentityPattern = new RegExp(
  `\\bconst\\s+(?:${joined("ORG", "(?:_ID)?")}|${joined("TENANT", "(?:_ID)?")}|${joined("ACTOR", "(?:_ID)?")})\\s*=\\s*["']` +
    `[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}["']`,
  "i",
);
const oneShotMutationPattern = new RegExp(
  `${joined("One", "-shot")}:[\\s\\S]{0,800}\\b(?:insert\\s+into|update|delete\\s+from)\\b`,
  "i",
);

function containsPrivateProvenance(value) {
  return containsPrivateIdentifier(value, privateFingerprints);
}

const connectorPaths = [
  /^\.gitignore$/,
  // Public interoperability documentation may name supported source systems.
  // Product/UI behavior remains vendor-neutral; these files are reviewed copy,
  // not executable defaults or tenant identity.
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  // The migration-assistant design note documents how each supported
  // source system's records are read; it is interoperability documentation.
  /^docs\/design\/migration-assistant\.md$/,
  /^scripts\/check-product-neutrality\.mjs$/,
  // The gate's own contract test quotes vendor names as fixture data; without
  // this line the prevention control could never describe what it prevents.
  /^scripts\/check-product-neutrality\.test\.mjs$/,
  // Connector implementations and their regression tests may name the system
  // they integrate with or verify: a test that cannot say which connector it
  // exercises cannot fail for the right reason. Product/UI code outside these
  // files stays vendor-neutral.
  /^engine\/src\/(?:connectors\/|qbd\/|sync\/)/,
  // Feature-gate and reversal invariants assert connector-specific gates and
  // source enums by exact file path; naming the system under test is the point
  // of these tests, not product copy.
  /^engine\/src\/records\/reversal-journal-lines\.integration\.test\.ts$/,
  /^web\/lib\/feature-gates\.test\.ts$/,
  /^engine\/src\/worker\/migration-worker\.ts$/,
  /^engine\/src\/harness\/differential\//,
  /^integrations\//,
  /^schema\/src\/(?:extension|qbd)\.ts$/,
  // The perf-1m rehearsal seeder writes functional connector-branch rows:
  // its qbd_requests hang off a qbd connection, the stable source key the
  // connector reads. Display copy in the seeder stays vendor-neutral; only
  // the functional key may name a system.
  /^scripts\/upgrade-rehearsal\/seeders\/perf-1m\.ts$/,
  /^web\/app\/\(app\)\/sync\//,
  // The connector application layer the sync pages and routes call: its
  // functions and tests configure a named source system's connection.
  /^web\/lib\/sync\//,
  /^web\/app\/api\/(?:platform\/connections|qbd)\//,
  /^web\/lib\/docs\/articles\/(?:netsuite-bridge|quickbooks-desktop-connector)\.ts$/,
  // Conformance tests for those connector articles: a test that cannot name
  // the article it verifies cannot fail for the right reason. Product/UI
  // copy outside these files stays vendor-neutral.
  /^web\/lib\/docs\/articles\/(?:netsuite-bridge|quickbooks-desktop-connector)\.test\.ts$/,
  /^web\/lib\/docs\/articles\/migrate-with-a-connector\.ts$/,
  /^web\/lib\/docs\/index\.ts$/,
  /^web\/messages\/[^/]+\/sync\.json$/,
  // The catalog-parity cognate list declares identical-by-fact strings by
  // their key, and connector keys live under their namespaces (sync.netsuite.*,
  // sync.qbd.*), which the locale files above already hold in scope.
  /^web\/messages\/catalog-parity\.test\.ts$/,
  // Burn-down list of source-pin tests. Its keys are repository-relative test
  // file paths and its values are integer counts, so it names the connector
  // tests already in scope above. It carries no product copy, no executable
  // defaults and no tenant identity.
  /^scripts\/test-source-pins\.allowlist\.json$/,
  // Relocation record for the engine module move. Its keys and values are
  // repository-relative file paths, so it names the connector client files it
  // moved exactly as the connector scope above does. No product copy.
  /^scripts\/engine-modules\/moves\.json$/,
  // Import budgets contain repository paths and integer occurrence counts.
  // Connector paths identify existing imports; they are not product copy.
  // Route-factory migration ledger. Its entries are repository-relative route
  // paths, so it names the connector OAuth routes exactly as the connector
  // scope above does. No product copy.
  /^scripts\/route-factory\.baseline\.json$/,
];

export function isConnectorPath(filePath) {
  return connectorPaths.some((pattern) => pattern.test(filePath));
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

function discoverPublicFiles() {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

/**
 * Audit the candidate public snapshot (tracked + untracked-but-not-ignored
 * files) and return every neutrality violation as a human-readable line.
 * Exported so the gate's policy is testable without a git fixture.
 */
/** Connector export names are interoperability contracts, not product copy.
 * Only exact mappings to existing connector sources receive that scope. */
export function connectorManifestVendorSource(source) {
  return source
    .split("\n")
    .map((line) => {
      const entry = /^\s*"\.\/connectors\/([a-z0-9-]+)": "\.\/src\/connectors\/\1\.ts",?\s*$/.exec(
        line,
      );
      return entry && existsSync(`engine/src/connectors/${entry[1]}.ts`) ? "" : line;
    })
    .join("\n");
}

export function auditPublicSnapshot(publicFiles) {
  const violations = [];

  for (const filePath of publicFiles) {
    // A tracked file deleted in the working tree is no longer part of the
    // candidate public snapshot, even before its deletion is staged.
    if (!existsSync(filePath)) continue;
    // TypeScript incremental state is a generated compiler cache, not product
    // copy or source. It embeds every imported filename and string literal.
    if (filePath.endsWith(".tsbuildinfo")) continue;
    if (
      privatePathPatterns.some((pattern) => pattern.test(filePath)) ||
      containsPrivateProvenance(filePath)
    ) {
      violations.push(`${filePath}: private provenance identifier in path`);
    }

    const vendorPathMatch = firstMatch(filePath, vendorPatterns);
    if (vendorPathMatch && !isConnectorPath(filePath)) {
      violations.push(`${filePath}: accounting-vendor name in non-connector path`);
    }

    let source;
    try {
      source = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    if (source.includes("\0")) continue;

    if (
      executableSourcePattern.test(filePath) &&
      !fixtureSourcePattern.test(filePath) &&
      (hardcodedOperatorIdentityPattern.test(source) || oneShotMutationPattern.test(source))
    ) {
      violations.push(
        `${filePath}: executable tenant-specific operator helper belongs outside the public product`,
      );
    }

    if (containsPrivateProvenance(source)) {
      violations.push(`${filePath}: private provenance identifier in public content`);
    }

    if (!isConnectorPath(filePath)) {
      const vendorSource =
        filePath === "engine/package.json" ? connectorManifestVendorSource(source) : source;
      const vendorMatch = firstMatch(vendorSource, vendorPatterns);
      if (vendorMatch) {
        const line = vendorSource.slice(0, vendorMatch.index).split("\n").length;
        violations.push(`${filePath}:${line}: accounting-vendor name outside connector scope`);
      }
    }
  }

  return violations;
}

function main() {
  const violations = auditPublicSnapshot(discoverPublicFiles());

  if (violations.length > 0) {
    console.error("Product-neutrality audit failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  if (privateFingerprints.size === 0) {
    console.warn(
      "Private identifier fingerprints are not configured; that part of the audit was skipped.",
    );
  }
  console.log("Product-neutrality audit passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
