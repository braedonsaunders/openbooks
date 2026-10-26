import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Customer, tenant and account identifiers that must never be published are
// supplied as SHA-256 fingerprints from outside the repository, so the
// prevention controls cannot themselves disclose or confirm them.
//
// Sources, first match wins:
//   OPENBOOKS_PRIVATE_FINGERPRINTS       fingerprints, whitespace/comma separated
//   OPENBOOKS_PRIVATE_FINGERPRINTS_FILE  path to a file holding them
//   <git common dir>/openbooks-private-fingerprints
// Lines starting with "#" in a fingerprint file are ignored.

const FINGERPRINT = /^[0-9a-f]{64}$/;

function parseFingerprints(text, origin) {
  const fingerprints = new Set();
  for (const line of text.split("\n")) {
    const content = line.trim();
    if (!content || content.startsWith("#")) continue;
    for (const entry of content.split(/[\s,]+/).filter(Boolean)) {
      const value = entry.toLowerCase();
      if (!FINGERPRINT.test(value)) {
        throw new Error(`${origin}: "${entry}" is not a SHA-256 hex fingerprint`);
      }
      fingerprints.add(value);
    }
  }
  return fingerprints;
}

function defaultFingerprintFile() {
  try {
    const commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return join(commonDir, "openbooks-private-fingerprints");
  } catch {
    return null;
  }
}

/**
 * Loads the configured fingerprints. An empty set means none are configured;
 * when `OPENBOOKS_REQUIRE_PRIVATE_FINGERPRINTS=1` that refuses instead.
 */
export function loadPrivateFingerprints(env = process.env) {
  let fingerprints = new Set();
  if (env.OPENBOOKS_PRIVATE_FINGERPRINTS?.trim()) {
    fingerprints = parseFingerprints(
      env.OPENBOOKS_PRIVATE_FINGERPRINTS,
      "OPENBOOKS_PRIVATE_FINGERPRINTS",
    );
  } else {
    const file = env.OPENBOOKS_PRIVATE_FINGERPRINTS_FILE || defaultFingerprintFile();
    if (env.OPENBOOKS_PRIVATE_FINGERPRINTS_FILE && !existsSync(file)) {
      throw new Error(`OPENBOOKS_PRIVATE_FINGERPRINTS_FILE does not exist: ${file}`);
    }
    if (file && existsSync(file))
      fingerprints = parseFingerprints(readFileSync(file, "utf8"), file);
  }
  if (fingerprints.size === 0 && env.OPENBOOKS_REQUIRE_PRIVATE_FINGERPRINTS === "1") {
    throw new Error(
      "Private identifier fingerprints are required but none are configured. " +
        "Set OPENBOOKS_PRIVATE_FINGERPRINTS or OPENBOOKS_PRIVATE_FINGERPRINTS_FILE.",
    );
  }
  return fingerprints;
}

/**
 * True when any token of `value` matches a fingerprint. Values are checked
 * both as alphanumeric tokens and as underscore-preserving source identifiers.
 */
export function containsPrivateIdentifier(value, fingerprints) {
  if (fingerprints.size === 0) return false;
  const lower = value.toLowerCase();
  const candidates = new Set([
    ...lower.split(/[^a-z0-9]+/).filter(Boolean),
    ...lower.split(/[^a-z0-9_]+/).filter(Boolean),
  ]);
  return [...candidates].some((candidate) =>
    fingerprints.has(createHash("sha256").update(candidate).digest("hex")),
  );
}
