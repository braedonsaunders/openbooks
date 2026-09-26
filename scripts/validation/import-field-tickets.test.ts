import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertImportOrgId,
  parseTicketTsv,
  resolveTicketIdentity,
  type ImportTicket,
} from "./field-ticket-import.ts";

const script = readFileSync(
  new URL("./import-field-tickets.ts", import.meta.url),
  "utf8",
);

const ticket = (overrides: Partial<ImportTicket> = {}): ImportTicket => ({
  sourceId: "9",
  number: "FT-9",
  jobRef: "JOB-1",
  empRef: "E1",
  customerRef: "C1",
  begin: "2024-06-10",
  end: "2024-06-16",
  billed: false,
  final: true,
  approval: "Yes",
  foremanRef: "F1",
  po: null,
  description: "Week nine",
  ...overrides,
});

test("the import target must be a UUID, naming what was received", () => {
  assert.equal(
    assertImportOrgId("123e4567-e89b-12d3-a456-426614174000"),
    "123e4567-e89b-12d3-a456-426614174000",
  );
  assert.throws(() => assertImportOrgId("not-a-uuid"), /--org must be a UUID/);
  assert.throws(() => assertImportOrgId(""), /--org must be a UUID/);
});

test("a quote in the import target refuses at parse, never in SQL", () => {
  assert.throws(
    () => assertImportOrgId("x' OR '1'='1"),
    /--org must be a UUID.*--org=<uuid>/,
  );
});

test("header TSV parsing keeps the source identity columns", () => {
  const rows = parseTicketTsv(
    "9\tFT-9\tJOB-1\tE1\tC1\t2024-06-10\t2024-06-16\tNo\tYes\tYes\tF1\tNULL\tWeek nine\nshort\trow\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sourceId, "9");
  assert.equal(rows[0]!.number, "FT-9");
  assert.equal(rows[0]!.jobRef, "JOB-1");
});

test("a replay requires an exact source-system and externalId match", () => {
  assert.equal(
    resolveTicketIdentity(ticket(), undefined, "test-source"),
    "create",
  );
  assert.equal(
    resolveTicketIdentity(
      ticket(),
      { id: "doc", sourceSystem: "test-source", sourceExternalId: "9" },
      "test-source",
    ),
    "replay",
  );
});

test("a same-number ticket from another source refuses by name", () => {
  assert.throws(
    () =>
      resolveTicketIdentity(
        ticket(),
        { id: "doc", sourceSystem: "other-connector", sourceExternalId: "99" },
        "test-source",
      ),
    /field ticket number FT-9 already exists from a different source \(system other-connector, external id 99\)/,
  );
});

test("a same-number ticket with no source marker refuses, never replays", () => {
  assert.throws(
    () =>
      resolveTicketIdentity(
        ticket(),
        { id: "doc", sourceSystem: null, sourceExternalId: null },
        "test-source",
      ),
    /already exists from a different source \(system unknown, external id unknown\)/,
  );
});

test("the import delegates identity to the core", () => {
  assert.match(script, /importFieldTickets\(/);
  assert.doesNotMatch(
    script,
    /existingTickets\.get\(t\.number\)/,
    "a bare number lookup must not decide a replay",
  );
  assert.doesNotMatch(
    script,
    /on conflict \(document_id\) do nothing/,
    "header attachment lives behind the identity check in the core",
  );
});
