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

/** Supply a published file's incomplete session header without changing its ledger identity. */
export function publishedMigrationSessionSettings(filename, content) {
  if (filename !== PUBLISHED_PARTIAL_HEADER.filename) return [];
  if (createHash("sha256").update(content).digest("hex") !== PUBLISHED_PARTIAL_HEADER.sha256) {
    throw new Error(`${filename} differs from its published digest — use the published bytes and make schema corrections through a new forward migration.`);
  }
  return PUBLISHED_PARTIAL_HEADER.settings;
}

export function publishedMigrationSessionPrelude(filename, content) {
  const settings = publishedMigrationSessionSettings(filename, content);
  return settings.length ? settings.map(({ sql }) => sql).join("\n") + "\n" : "";
}
