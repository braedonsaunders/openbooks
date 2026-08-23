#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  containsProhibitedIdentifier,
  loadProhibitedIdentifierHashes,
  redactLikeCallbacks,
} from "./build-callbacks.mjs";

const prohibitedPathPatterns = [
  /(?:^|\/)\.local\/tenant-migrations(?:\/|$)/i,
  /(?:^|\/)account-data(?:\/|$)/i,
  /(?:^|\/)extraction(?:\/|$)/i,
  /(?:^|\/)objects-list\.txt$/i,
];

// These entries mirror the future git-filter-repo invocation in README.md.
// A literal path matches that path or a directory prefix, as filter-repo does.
const plannedPathFilters = [
  { kind: "path", expression: ".local/tenant-migrations" },
  { kind: "glob", expression: "*/.local/tenant-migrations" },
  { kind: "glob", expression: "*/.local/tenant-migrations/*" },
  { kind: "path", expression: "account-data" },
  { kind: "glob", expression: "*/account-data" },
  { kind: "glob", expression: "*/account-data/*" },
  { kind: "path", expression: "extraction" },
  { kind: "glob", expression: "*/extraction" },
  { kind: "glob", expression: "*/extraction/*" },
  { kind: "glob", expression: "objects-list.txt" },
  { kind: "glob", expression: "*/objects-list.txt" },
];

function git(...args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isProhibitedPathClass(value) {
  return prohibitedPathPatterns.some((pattern) => pattern.test(value));
}

function literalPathMatches(expression, path) {
  if (!path.startsWith(expression)) return false;
  return (
    expression.endsWith("/") ||
    path.length === expression.length ||
    path[expression.length] === "/"
  );
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u");
}

const compiledPathFilters = plannedPathFilters.map((filter) => ({
  ...filter,
  regex:
    filter.kind === "glob" ? globToRegExp(filter.expression) : undefined,
}));

function plannedPurgeMatches(path) {
  return compiledPathFilters.some((filter) =>
    filter.kind === "path"
      ? literalPathMatches(filter.expression, path)
      : filter.regex.test(path),
  );
}

function auditSiblingFiles(hashes) {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(scriptDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const failures = [];

  for (const filename of files) {
    const contents = readFileSync(join(scriptDirectory, filename), "utf8");
    if (
      containsProhibitedIdentifier(filename, hashes) ||
      containsProhibitedIdentifier(contents, hashes)
    ) {
      failures.push(filename);
    }
  }

  return { filesScanned: files.length, failures };
}

function run() {
  const hashes = loadProhibitedIdentifierHashes();
  const counts = {
    prohibitedPathClass: 0,
    identifierInPath: 0,
    identifierInSubject: 0,
  };
  const coverage = {
    purgedPaths: 0,
    redactedPaths: 0,
    redactedSubjects: 0,
    uncoveredProhibitedPaths: 0,
    unexpectedPurgedPaths: 0,
    unchangedIdentifierPaths: 0,
    unchangedIdentifierSubjects: 0,
  };
  let simulatedRemainingViolations = 0;

  for (const line of git("rev-list", "--objects", "--all").split("\n")) {
    const separator = line.indexOf(" ");
    if (separator < 0) continue;
    const path = line.slice(separator + 1);
    const prohibitedPathClass = isProhibitedPathClass(path);
    const identifierInPath = containsProhibitedIdentifier(path, hashes);
    const plannedPurge = plannedPurgeMatches(path);

    if (prohibitedPathClass) {
      counts.prohibitedPathClass += 1;
    } else if (identifierInPath) {
      counts.identifierInPath += 1;
    }

    if (prohibitedPathClass && !plannedPurge) {
      coverage.uncoveredProhibitedPaths += 1;
    }
    if (!prohibitedPathClass && plannedPurge) {
      coverage.unexpectedPurgedPaths += 1;
    }
    if (plannedPurge) {
      coverage.purgedPaths += 1;
      continue;
    }

    const transformedPath = redactLikeCallbacks(path, hashes);
    if (identifierInPath) {
      coverage.redactedPaths += 1;
      if (transformedPath === path) {
        coverage.unchangedIdentifierPaths += 1;
      }
    }
    if (
      isProhibitedPathClass(transformedPath) ||
      containsProhibitedIdentifier(transformedPath, hashes)
    ) {
      simulatedRemainingViolations += 1;
    }
  }

  for (const line of git("log", "--all", "--format=%H%x09%s").split("\n")) {
    if (!line) continue;
    const [, ...subjectParts] = line.split("\t");
    const subject = subjectParts.join("\t");
    const identifierInSubject = containsProhibitedIdentifier(subject, hashes);
    const transformedSubject = redactLikeCallbacks(subject, hashes);

    if (identifierInSubject) {
      counts.identifierInSubject += 1;
      coverage.redactedSubjects += 1;
      if (transformedSubject === subject) {
        coverage.unchangedIdentifierSubjects += 1;
      }
    }
    if (containsProhibitedIdentifier(transformedSubject, hashes)) {
      simulatedRemainingViolations += 1;
    }
  }

  const total =
    counts.prohibitedPathClass +
    counts.identifierInPath +
    counts.identifierInSubject;
  const siblingAudit = auditSiblingFiles(hashes);
  const coverageFailures =
    coverage.uncoveredProhibitedPaths +
    coverage.unexpectedPurgedPaths +
    coverage.unchangedIdentifierPaths +
    coverage.unchangedIdentifierSubjects;
  const passed =
    coverageFailures === 0 &&
    simulatedRemainingViolations === 0 &&
    siblingAudit.failures.length === 0;

  process.stdout.write(`Current gate-equivalent violation inventory:\n`);
  process.stdout.write(
    `  prohibited path class: ${counts.prohibitedPathClass}\n`,
  );
  process.stdout.write(`  identifier in path: ${counts.identifierInPath}\n`);
  process.stdout.write(
    `  identifier in subject: ${counts.identifierInSubject}\n`,
  );
  process.stdout.write(`  total: ${total}\n`);
  process.stdout.write(`Planned transform coverage:\n`);
  process.stdout.write(`  paths selected for purge: ${coverage.purgedPaths}\n`);
  process.stdout.write(`  identifier paths redacted: ${coverage.redactedPaths}\n`);
  process.stdout.write(
    `  identifier subjects redacted: ${coverage.redactedSubjects}\n`,
  );
  process.stdout.write(
    `  uncovered prohibited paths: ${coverage.uncoveredProhibitedPaths}\n`,
  );
  process.stdout.write(
    `  unexpected paths selected for purge: ${coverage.unexpectedPurgedPaths}\n`,
  );
  process.stdout.write(
    `  simulated remaining violations: ${simulatedRemainingViolations}\n`,
  );
  process.stdout.write(
    `Sibling self-audit: ${siblingAudit.filesScanned} files scanned, ${siblingAudit.failures.length} failures\n`,
  );

  if (!passed) {
    if (siblingAudit.failures.length > 0) {
      process.stderr.write(
        `Sibling self-audit failed in ${siblingAudit.failures.length} file(s); token values are intentionally suppressed.\n`,
      );
    }
    process.stderr.write(
      "Dry-run failed: the planned rewrite does not simulate a clean history.\n",
    );
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "PASS: the planned transforms simulate a clean full-history gate.\n",
  );
}

try {
  run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dry-run failed: ${message}\n`);
  process.exitCode = 1;
}
