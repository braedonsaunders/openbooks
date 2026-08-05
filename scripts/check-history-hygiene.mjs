import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

// Store fingerprints—not customer or tenant names—so this prevention gate
// cannot itself reintroduce prohibited identifiers into the repository.
const prohibitedIdentifierHashes = new Set([
  "c1d64b2d4cb30f1be788cc4d246ddd9fc1fe85a3eb3a85a3de33829dfaf6ce7d",
  "97d958f8ade08a05a1b0d56dc5584c28c26ffc33343ee9dabdab2160dbbb7c5a",
  "822b33ad87c148a0a20a5ba7cd5ebcaa68d36a18e7aad165554903f52ca82757",
  "13984a4e7e0edce830a005d227b04ad31cd1056020fd0a7b9760364161735aa4",
  "b370de14e94142d4a108a79df6d0e265a0ba3fa2e10f57c4b3a892b74c9f84aa",
  "8bb0cf6eb9b17d0f7d22b456f121257dc1254e1f01665370476383ea776df414",
  "97c489b6c1231ecd9fac99df40e60cec000a70a057d5971fb520c578da8e8841",
  "3fb836229505c02d85ef0286b0c93213db710766d841f00d91db5edaeade136b",
  "24eb33c5f8f98314500b1c7f3fe403413c3b3fe0e4ae8ac5cc464dd2b686802c",
  "dc398d3ce272308eb4840746242a7e4fa26062e2a12c054f37c28b4885ab7088",
  "f51c932e385f53f667ac191dabd038d8edfc853b2bc8d51e8ec15a7d8b94c976",
  "bdc2796f3142ff7110bf62e47f1e4ddef65ae81187fef176994cedd2bda688c8",
  "d289463ba9b283feb838d61b3a23555ac7a62a627569e11c5381c997bedee474",
]);

const prohibitedPathPatterns = [
  /(?:^|\/)\.local\/tenant-migrations(?:\/|$)/i,
  /(?:^|\/)account-data(?:\/|$)/i,
  /(?:^|\/)extraction(?:\/|$)/i,
  /(?:^|\/)objects-list\.txt$/i,
];

function containsProhibitedIdentifier(value) {
  const lower = value.toLowerCase();
  const tokens = new Set([
    ...lower.split(/[^a-z0-9]+/).filter(Boolean),
    ...lower.split(/[^a-z0-9_]+/).filter(Boolean),
  ]);
  return [...tokens].some((token) =>
    prohibitedIdentifierHashes.has(
      createHash("sha256").update(token).digest("hex"),
    ),
  );
}

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const violations = [];
for (const line of git("rev-list", "--objects", "--all").split("\n")) {
  const separator = line.indexOf(" ");
  if (separator < 0) continue;
  const objectId = line.slice(0, separator);
  const path = line.slice(separator + 1);
  if (prohibitedPathPatterns.some((pattern) => pattern.test(path))) {
    violations.push(`${objectId}: prohibited private-data path class`);
  } else if (containsProhibitedIdentifier(path)) {
    violations.push(
      `${objectId}: prohibited customer/tenant identifier in path`,
    );
  }
}

for (const line of git("log", "--all", "--format=%H%x09%s").split("\n")) {
  if (!line) continue;
  const [commitId, ...subjectParts] = line.split("\t");
  if (containsProhibitedIdentifier(subjectParts.join("\t"))) {
    violations.push(
      `${commitId}: prohibited customer/tenant identifier in commit subject`,
    );
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Git history hygiene check failed. Rewrite the affected refs before publication:\n",
  );
  for (const violation of [...new Set(violations)].slice(0, 100)) {
    process.stderr.write(`- ${violation}\n`);
  }
  if (violations.length > 100)
    process.stderr.write(`- and ${violations.length - 100} more\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Git history contains no prohibited private-data paths or identifiers.\n",
  );
}
