import { execFileSync } from "node:child_process";
import { containsPrivateIdentifier, loadPrivateFingerprints } from "./private-identifiers.mjs";

// Customer, tenant and account identifiers are matched by fingerprint, loaded
// from outside the repository (see private-identifiers.mjs).
const fingerprints = loadPrivateFingerprints();

const prohibitedPathPatterns = [
  /(?:^|\/)\.local\/tenant-migrations(?:\/|$)/i,
  /(?:^|\/)account-data(?:\/|$)/i,
  /(?:^|\/)extraction(?:\/|$)/i,
  /(?:^|\/)objects-list\.txt$/i,
];

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
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
  } else if (containsPrivateIdentifier(path, fingerprints)) {
    violations.push(`${objectId}: prohibited customer/tenant identifier in path`);
  }
}

// Whole messages and both identities: a body or an author address publishes
// as much as a subject does.
for (const record of git("log", "--all", "--format=%H%x1f%an <%ae>%x1f%cn <%ce>%x1f%B%x1e").split(
  "\x1e",
)) {
  const [commitId, author, committer, message] = record.replace(/^\n/, "").split("\x1f");
  if (!commitId || message === undefined) continue;
  if (containsPrivateIdentifier(message, fingerprints)) {
    violations.push(`${commitId}: prohibited customer/tenant identifier in commit message`);
  }
  if (containsPrivateIdentifier(`${author} ${committer}`, fingerprints)) {
    violations.push(`${commitId}: prohibited customer/tenant identifier in commit identity`);
  }
}

if (violations.length > 0) {
  process.stderr.write(
    "Git history hygiene check failed. Rewrite the affected refs before publication:\n",
  );
  for (const violation of [...new Set(violations)].slice(0, 100)) {
    process.stderr.write(`- ${violation}\n`);
  }
  if (violations.length > 100) process.stderr.write(`- and ${violations.length - 100} more\n`);
  process.exitCode = 1;
} else if (fingerprints.size === 0) {
  process.stdout.write(
    "Git history contains no prohibited private-data paths; identifier fingerprints are not configured, so identifiers were not checked.\n",
  );
} else {
  process.stdout.write("Git history contains no prohibited private-data paths or identifiers.\n");
}
