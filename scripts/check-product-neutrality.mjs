import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

// Known customer, tenant, predecessor-codebase, installed-SuiteApp, account,
// and incident identifiers must never enter tracked product files. Split the
// literals here so this audit does not whitelist itself by containing them.
const privateProvenancePatterns = [
  new RegExp(joined("Ras", "saun"), "i"),
  new RegExp(joined("Bir", "la"), "i"),
  new RegExp(joined("Admin", "App2"), "i"),
  new RegExp(joined("Beacon", "HS"), "i"),
  new RegExp(joined("Gan", "try"), "i"),
  new RegExp(joined("863", "8714")),
  new RegExp(joined("635", "982")),
  new RegExp(joined("647", "409")),
  new RegExp(joined("647", "410")),
];

const connectorPaths = [
  /^\.gitignore$/,
  // Public interoperability documentation may name supported source systems.
  // Product/UI behavior remains vendor-neutral; these files are reviewed copy,
  // not executable defaults or tenant identity.
  /^README\.md$/,
  /^CHANGELOG\.md$/,
  /^scripts\/check-product-neutrality\.mjs$/,
  /^engine\/src\/(?:netsuite|qbo\.ts$|xero\.ts$|odoo\.ts$|erpnext\.ts$|dynamics\.ts$|qbd\/|sync\/)/,
  /^engine\/src\/worker\/migration-worker\.ts$/,
  /^engine\/src\/harness\/ledger-parity\//,
  /^extraction\//,
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
  // TypeScript incremental state is a generated compiler cache, not product
  // copy or source. It embeds every imported filename and string literal.
  if (filePath.endsWith(".tsbuildinfo")) continue;
  const provenancePathMatch = firstMatch(filePath, privateProvenancePatterns);
  if (provenancePathMatch) {
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

  const provenanceMatch = firstMatch(source, privateProvenancePatterns);
  if (provenanceMatch) {
    const line = source.slice(0, provenanceMatch.index).split("\n").length;
    violations.push(
      `${filePath}:${line}: private provenance identifier in public content`,
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
