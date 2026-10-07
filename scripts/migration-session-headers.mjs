import { createHash } from "node:crypto";

const PUBLISHED_PARTIAL_HEADER = Object.freeze({
  filename: "generated/0572_optional_custom_dimension_assignments.sql",
  sha256: "de1ddc2b3f2bf8f2ac106eedeb1d328095823fc67bcd59612032f303e8fd7f78",
  settings: Object.freeze([
    Object.freeze({ name: "idle_in_transaction_session_timeout", sql: "SET idle_in_transaction_session_timeout = 0;" }),
    Object.freeze({ name: "client_encoding", sql: "SET client_encoding = 'UTF8';" }),
    Object.freeze({ name: "standard_conforming_strings", sql: "SET standard_conforming_strings = on;" }),
    Object.freeze({ name: "client_min_messages", sql: "SET client_min_messages = warning;" }),
  ]),
});

const PUBLISHED_RUNNER_LOCK_HEADER = Object.freeze({
  filename: "generated/0580_clone_preserves_recorded_document_balances.sql",
  sha256: "1ee33f04b4c0cfe6c1725d19d08cc613e593bbc2c63a499ae9e58b0b419ca59b",
  settings: Object.freeze([]),
  runnerOwnsLockTimeout: true,
});

function publishedSessionPolicy(filename, content) {
  const policy = [PUBLISHED_PARTIAL_HEADER, PUBLISHED_RUNNER_LOCK_HEADER]
    .find((entry) => entry.filename === filename);
  if (!policy) return null;
  if (createHash("sha256").update(content).digest("hex") !== policy.sha256) {
    throw new Error(`${filename} differs from its published digest — use the published bytes and make schema corrections through a new forward migration.`);
  }
  return policy;
}

/** Supply a published file's incomplete session header without changing its ledger identity. */
export function publishedMigrationSessionSettings(filename, content) {
  return publishedSessionPolicy(filename, content)?.settings ?? [];
}

/** Admit only reviewed immutable bytes whose file-level timeout the runner strips. */
export function publishedMigrationUsesRunnerLockTimeout(filename, content) {
  return publishedSessionPolicy(filename, content)?.runnerOwnsLockTimeout === true;
}

export function publishedMigrationSessionPrelude(filename, content) {
  const settings = publishedMigrationSessionSettings(filename, content);
  return settings.length ? settings.map(({ sql }) => sql).join("\n") + "\n" : "";
}
