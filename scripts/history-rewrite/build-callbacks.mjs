#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REDACTION = "[REDACTED]";

const gatePath = fileURLToPath(
  new URL("../check-history-hygiene.mjs", import.meta.url),
);

export function loadProhibitedIdentifierHashes() {
  const gateSource = readFileSync(gatePath, "utf8");
  const declaration = gateSource.match(
    /const\s+prohibitedIdentifierHashes\s*=\s*new Set\(\[([\s\S]*?)\]\);/u,
  );

  if (!declaration) {
    throw new Error(
      "could not find prohibitedIdentifierHashes in check-history-hygiene.mjs",
    );
  }

  const hashes = [
    ...declaration[1].matchAll(/"([0-9a-f]{64})"/gu),
  ].map((match) => match[1]);
  const residue = declaration[1]
    .replaceAll(/"[0-9a-f]{64}"/gu, "")
    .replaceAll(/[\s,]/gu, "");

  if (hashes.length === 0 || residue.length > 0) {
    throw new Error(
      "prohibitedIdentifierHashes has an unexpected format; refusing to generate callbacks",
    );
  }
  if (new Set(hashes).size !== hashes.length) {
    throw new Error(
      "prohibitedIdentifierHashes contains duplicates; refusing to generate callbacks",
    );
  }

  return new Set(hashes);
}

export function tokensLikeGate(value) {
  const lower = value.toLowerCase();
  return new Set([
    ...lower.split(/[^a-z0-9]+/u).filter(Boolean),
    ...lower.split(/[^a-z0-9_]+/u).filter(Boolean),
  ]);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function containsProhibitedIdentifier(value, hashes) {
  return [...tokensLikeGate(value)].some((token) =>
    hashes.has(tokenHash(token)),
  );
}

export function redactLikeCallbacks(value, hashes) {
  const redactIfProhibited = (token) =>
    hashes.has(tokenHash(token.toLowerCase())) ? REDACTION : token;

  // Run the underscore-preserving tokenization first. If that whole token is
  // not prohibited, the second pass handles its alphanumeric sub-tokens.
  return value
    .replace(/[a-z0-9_]+/giu, redactIfProhibited)
    .replace(/[a-z0-9]+/giu, redactIfProhibited);
}

function pythonHashSet(hashes) {
  return [...hashes]
    .sort()
    .map((hash) => `    "${hash}",`)
    .join("\n");
}

function buildPythonCallback(inputName, hashes, { nullable = false } = {}) {
  const nullableGuard = nullable
    ? `if ${inputName} is None:\n  return None\n`
    : "";

  return `${nullableGuard}import hashlib
import re

prohibited_identifier_hashes = {
${pythonHashSet(hashes)}
}

def redact_token(match):
  token = match.group(0)
  token_hash = hashlib.sha256(token.lower()).hexdigest()
  return b"${REDACTION}" if token_hash in prohibited_identifier_hashes else token

value = re.sub(br"[A-Za-z0-9_]+", redact_token, ${inputName})
value = re.sub(br"[A-Za-z0-9]+", redact_token, value)
return value`;
}

export function buildCallbacks(hashes = loadProhibitedIdentifierHashes()) {
  if (containsProhibitedIdentifier(REDACTION, hashes)) {
    throw new Error("the replacement literal is prohibited by the active gate");
  }

  return {
    filenameCallback: buildPythonCallback("filename", hashes, {
      nullable: true,
    }),
    messageCallback: buildPythonCallback("message", hashes),
  };
}

function printUsage() {
  process.stdout.write(`Usage: node scripts/history-rewrite/build-callbacks.mjs [option]

Options:
  --filename  Print the git-filter-repo filename callback body
  --message   Print the git-filter-repo message callback body
  --json      Print both callback bodies as JSON (default)
  --help      Show this help
`);
}

function main() {
  const hashes = loadProhibitedIdentifierHashes();
  const callbacks = buildCallbacks(hashes);
  const option = process.argv[2] ?? "--json";

  switch (option) {
    case "--filename":
      process.stdout.write(callbacks.filenameCallback);
      break;
    case "--message":
      process.stdout.write(callbacks.messageCallback);
      break;
    case "--json":
      process.stdout.write(
        `${JSON.stringify(
          {
            hashCount: hashes.size,
            ...callbacks,
          },
          null,
          2,
        )}\n`,
      );
      break;
    case "--help":
      printUsage();
      break;
    default:
      process.stderr.write(`Unknown option: ${option}\n`);
      printUsage();
      process.exitCode = 64;
  }
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`build-callbacks failed: ${message}\n`);
    process.exitCode = 1;
  }
}
