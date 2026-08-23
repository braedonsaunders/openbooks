import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

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

// Fingerprints keep customer, tenant, account and incident identifiers out of
// the prevention control itself. Candidates are checked both as ordinary
// tokens and as underscore-preserving source identifiers.
const privateProvenanceHashes = new Set([
  "822b33ad87c148a0a20a5ba7cd5ebcaa68d36a18e7aad165554903f52ca82757",
  "13984a4e7e0edce830a005d227b04ad31cd1056020fd0a7b9760364161735aa4",
  "97d958f8ade08a05a1b0d56dc5584c28c26ffc33343ee9dabdab2160dbbb7c5a",
  "b370de14e94142d4a108a79df6d0e265a0ba3fa2e10f57c4b3a892b74c9f84aa",
  "c1d64b2d4cb30f1be788cc4d246ddd9fc1fe85a3eb3a85a3de33829dfaf6ce7d",
  "8bb0cf6eb9b17d0f7d22b456f121257dc1254e1f01665370476383ea776df414",
  "97c489b6c1231ecd9fac99df40e60cec000a70a057d5971fb520c578da8e8841",
  "3fb836229505c02d85ef0286b0c93213db710766d841f00d91db5edaeade136b",
  "24eb33c5f8f98314500b1c7f3fe403413c3b3fe0e4ae8ac5cc464dd2b686802c",
  "dc398d3ce272308eb4840746242a7e4fa26062e2a12c054f37c28b4885ab7088",
  "f51c932e385f53f667ac191dabd038d8edfc853b2bc8d51e8ec15a7d8b94c976",
  "bdc2796f3142ff7110bf62e47f1e4ddef65ae81187fef176994cedd2bda688c8",
  "d289463ba9b283feb838d61b3a23555ac7a62a627569e11c5381c997bedee474",
]);

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
const fixtureSourcePattern = /(?:^|\/)(?:__tests__|fixtures?|tests?)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i;
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
  const lower = value.toLowerCase();
  const candidates = new Set([
    ...lower.split(/[^a-z0-9]+/).filter(Boolean),
    ...lower.split(/[^a-z0-9_]+/).filter(Boolean),
  ]);
  return [...candidates].some((candidate) =>
    privateProvenanceHashes.has(
      createHash("sha256").update(candidate).digest("hex"),
    ),
  );
}

const connectorPaths = [
  /^\.gitignore$/,
  // Public interoperability documentation may name supported source systems.
  // Product/UI behavior remains vendor-neutral; these files are reviewed copy,
  // not executable defaults or tenant identity.
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^scripts\/check-product-neutrality\.mjs$/,
  /^engine\/src\/(?:netsuite|qbo\.ts$|xero\.ts$|odoo\.ts$|erpnext\.ts$|dynamics\.ts$|qbd\/|sync\/)/,
  // Feature-gate and reversal invariants assert connector-specific gates and
  // source enums by exact file path; naming the system under test is the point
  // of these tests, not product copy.
  /^engine\/src\/reversal-journal-lines\.integration\.test\.ts$/,
  /^web\/lib\/feature-gates\.test\.ts$/,
  /^engine\/src\/worker\/migration-worker\.ts$/,
  /^engine\/src\/harness\/ledger-parity\//,
  /^engine\/src\/harness\/differential\//,
  /^integrations\//,
  /^scripts\/verify-financial-release\.ts$/,
  /^schema\/src\/(?:extension|qbd)\.ts$/,
  /^schema\/migrations\/generated\/0045_canonical_customer_parties\.sql$/,
  /^schema\/migrations\/generated\/0109_schema_convergence_and_legacy_evidence\.sql$/,
  /^web\/app\/\(app\)\/sync\//,
  /^web\/app\/api\/(?:platform\/connections|qbd)\//,
  /^web\/lib\/docs\/articles\/(?:netsuite-bridge|quickbooks-desktop-connector)\.ts$/,
  /^web\/lib\/docs\/articles\/migrate-with-a-connector\.ts$/,
  /^web\/lib\/docs\/index\.ts$/,
  /^web\/messages\/[^/]+\/sync\.json$/,
];

function isConnectorPath(filePath) {
  return connectorPaths.some((pattern) => pattern.test(filePath));
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match) return match;
  }
  return null;
}

const publicFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    encoding: "utf8",
  },
)
  .split("\0")
  .filter(Boolean);

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
    violations.push(
      `${filePath}: accounting-vendor name in non-connector path`,
    );
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
    violations.push(
      `${filePath}: private provenance identifier in public content`,
    );
  }

  if (!isConnectorPath(filePath)) {
    const vendorMatch = firstMatch(source, vendorPatterns);
    if (vendorMatch) {
      const line = source.slice(0, vendorMatch.index).split("\n").length;
      violations.push(
        `${filePath}:${line}: accounting-vendor name outside connector scope`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Product-neutrality audit failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log("Product-neutrality audit passed.");
