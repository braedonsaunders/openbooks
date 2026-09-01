import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
  "fa32bdd07499522b9e099829d524820571854df53a467b14b08ebd3d2286d6ce",
  "cbd74271cc98249a368d5e1b7c6f0636ad4132fa123a6f90e6df50731ed375f3",
  "b7d43aed608d1cbb1afefb42e2be6763530e5aee6994d25867246c8fa4703bd9",
  "2a8883bc38f9bc430dbe4349245808633c55ed72db3e383832d905b2dfa44416",
  "3014637776d42a85266a46eecaa689d23eed6e49a3cea1f282afce1001b796c7",
  "a8cfc74482c018974f6b9e56c865ba1d718007bc295a305d4ead3964d5f09e5d",
  "9241579e6ad3afa278e55151a0c2751af9a9c655b2db25d35a4845f6267689c8",
  "6e5e825c558c5d993bb79cd4384690edb8bf2ed67d5c623baaf34dcbc78aeb77",
  "dae3be6c1355614ec0d577941b51fbbb961465f589b6cff36b3de0359280c72f",
  "2624169ff3689d21f7dda5f47e2abecca8fb714e94227a21f47948a41e5909d8",
  "3d0b6788d0209c7fde7a398c2a27f6c53aeb4dcada97cf98104320f9f367cbf2",
  "a9ed492dcb98579d9b98479b4c1374dab9ee234e529e7ebb54c5ef7d39a6914f",
  "674523586ff93cc6290f7d949b831d1c2599412995a0aafe962f06c3ce893578",
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
  // The gate's own contract test quotes vendor names as fixture data; without
  // this line the prevention control could never describe what it prevents.
  /^scripts\/check-product-neutrality\.test\.mjs$/,
  // Connector implementations and their regression tests may name the system
  // they integrate with or verify: a test that cannot say which connector it
  // exercises cannot fail for the right reason. Product/UI code outside these
  // files stays vendor-neutral.
  /^engine\/src\/(?:netsuite|(?:qbo|xero|odoo|erpnext|dynamics)(?:\.test)?\.ts$|qbd\/|sync\/)/,
  // Feature-gate and reversal invariants assert connector-specific gates and
  // source enums by exact file path; naming the system under test is the point
  // of these tests, not product copy.
  /^engine\/src\/reversal-journal-lines\.integration\.test\.ts$/,
  /^web\/lib\/feature-gates\.test\.ts$/,
  /^engine\/src\/worker\/migration-worker\.ts$/,
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
  return execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
    },
  )
    .split("\0")
    .filter(Boolean);
}

/**
 * Audit the candidate public snapshot (tracked + untracked-but-not-ignored
 * files) and return every neutrality violation as a human-readable line.
 * Exported so the gate's policy is testable without a git fixture.
 */
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

  return violations;
}

function main() {
  const violations = auditPublicSnapshot(discoverPublicFiles());

  if (violations.length > 0) {
    console.error("Product-neutrality audit failed:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exit(1);
  }

  console.log("Product-neutrality audit passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
