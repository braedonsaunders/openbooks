import assert from "node:assert/strict";
import test from "node:test";
import {
  assertImportOrgId,
  assertChargeWriteAllowed,
  classifyTicketIdentity,
  importFieldTickets,
  matchBillableChargeLines,
  parseBillableChargesJson,
  resolveTicketIdentity,
  type ImportBillableCharge,
  type SourceChargeLine,
} from "./field-ticket-import.ts";
import {
  fieldTicketSourceHeaderRowSha256,
  parseFieldTicketSourceHeaderTsv,
  type FieldTicketSourceHeaderRow,
} from "@openbooks/engine/projects/field-ticket-source-headers";

const ticket = (
  overrides: Partial<FieldTicketSourceHeaderRow> = {},
): FieldTicketSourceHeaderRow => ({
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
  superintendentRef: "S1",
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
  assert.throws(() => assertImportOrgId("x' OR '1'='1"), /--org must be a UUID.*--org=<uuid>/);
});

test("header TSV parsing keeps the source identity columns", () => {
  const rows = parseFieldTicketSourceHeaderTsv(
    "9\tFT-9\tJOB-1\tE1\tC1\t2024-06-10\t2024-06-16\tNo\tYes\tYes\tF1\tNULL\tWeek nine\nshort\trow\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sourceId, "9");
  assert.equal(rows[0]!.number, "FT-9");
  assert.equal(rows[0]!.jobRef, "JOB-1");
  assert.equal(rows[0]!.foremanRef, "F1");
  assert.equal(rows[0]!.superintendentRef, undefined);
  assert.equal(rows[0]!.po, null);
  assert.equal(rows[0]!.description, "Week nine");
});

test("header TSV parsing imports both ticket crew roles in the extended format", () => {
  const rows = parseFieldTicketSourceHeaderTsv(
    "9\tFT-9\tJOB-1\tE1\tC1\t2024-06-10\t2024-06-16\tNo\tYes\tYes\tF1\tS1\tPO-9\tWeek nine\n",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.foremanRef, "F1");
  assert.equal(rows[0]!.superintendentRef, "S1");
  assert.equal(rows[0]!.po, "PO-9");
  assert.equal(rows[0]!.description, "Week nine");
});

test("a replay requires an exact source-system and externalId match", () => {
  assert.equal(resolveTicketIdentity(ticket(), undefined, "test-source"), "create");
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

test("partial source identities cannot become exact replays", () => {
  for (const identity of [
    { sourceSystem: "test-source", sourceExternalId: null },
    { sourceSystem: null, sourceExternalId: "9" },
    { sourceSystem: "test-source", sourceExternalId: "99" },
    { sourceSystem: "other-connector", sourceExternalId: "9" },
  ]) {
    assert.throws(
      () => resolveTicketIdentity(ticket(), { id: "doc", ...identity }, "test-source"),
      /source test-source ticket 9 is not represented/,
    );
  }
});

test("identity plans hold unsourced records and incomplete metadata without claiming adoption", () => {
  const held = classifyTicketIdentity({
    ticket: ticket(),
    sourceSystem: "test-source",
    existing: { id: "doc", sourceSystem: null, sourceExternalId: null },
  });
  assert.equal(held.action, "admission_held");
  assert.equal(held.adoptionPerformed, false);
  assert.deepEqual(held.reasons, [
    "native_ticket_source_lineage_missing",
    "governed_native_identity_certification_required",
  ]);
  assert.equal(
    classifyTicketIdentity({
      ticket: ticket(),
      sourceSystem: "test-source",
      existing: { id: "doc", sourceSystem: null, sourceExternalId: null, hasSourceMetadata: true },
    }).action,
    "mismatch",
  );
  assert.equal(
    classifyTicketIdentity({
      ticket: ticket(),
      sourceSystem: "test-source",
      existing: undefined,
      sourceIdentityConflict: true,
    }).action,
    "mismatch",
  );
  assert.equal(
    classifyTicketIdentity({
      ticket: ticket(),
      sourceSystem: "test-source",
      existing: undefined,
      unresolvedReferences: true,
    }).action,
    "admission_held",
  );
  assert.equal(
    classifyTicketIdentity({
      ticket: ticket(),
      sourceSystem: "test-source",
      existing: {
        id: "doc",
        sourceSystem: "test-source",
        sourceExternalId: "9",
        projectId: "project",
        subsidiaryId: "other-entity",
      },
      expectedProjectId: "project",
      expectedSubsidiaryId: "entity",
    }).action,
    "mismatch",
  );
  assert.equal(
    classifyTicketIdentity({
      ticket: ticket(),
      sourceSystem: "test-source",
      existing: { id: "doc", sourceSystem: "test-source", sourceExternalId: "9" },
    }).action,
    "exact_replay",
  );
});

test("valid artifact hashes and an asserted number or amount match cannot authorize source binding", async () => {
  const attempt = {
    orgId: "123e4567-e89b-12d3-a456-426614174000",
    sourceSystem: "test-source",
    tickets: [ticket()],
    apply: true,
    sourceProof: { headersSha256: "a".repeat(64), chargesSha256: "b".repeat(64) },
    identityBindings: [
      {
        sourceSystem: "test-source",
        sourceTicketId: "9",
        nativeDocumentId: "123e4567-e89b-12d3-a456-426614174001",
        expectedUpdatedAt: "2026-10-14T12:00:00Z",
        subsidiaryId: "123e4567-e89b-12d3-a456-426614174002",
        sourceRowSha256: fieldTicketSourceHeaderRowSha256(ticket()),
        reason: "Ticket number and aggregate amount match",
        nativeSubtotal: "95.0000",
      },
    ],
  };
  await assert.rejects(
    () => importFieldTickets(attempt),
    /source identity admission is held.*identity-binding manifests are not supported/,
  );
});

test("source row provenance distinguishes an omitted superintendent from an explicit removal", () => {
  assert.notEqual(
    fieldTicketSourceHeaderRowSha256(ticket({ superintendentRef: undefined })),
    fieldTicketSourceHeaderRowSha256(ticket({ superintendentRef: null })),
  );
});

const charge = (overrides: Partial<ImportBillableCharge> = {}): ImportBillableCharge => ({
  sourceId: "28575",
  ticketRef: "26684",
  jobRef: "324204",
  itemRef: "2461",
  sourceDocumentRef: null,
  amount: "95.00",
  quantity: "1.00",
  unitPrice: "95.00",
  occurredOn: "2026-08-22",
  ...overrides,
});

test("billable-timesheet JSON keeps source money and quantity as exact decimals", () => {
  assert.deepEqual(parseBillableChargesJson(JSON.stringify([charge()])), [
    { ...charge(), amount: "95.0000", quantity: "1.00000000", unitPrice: "95.00000000" },
  ]);
  assert.throws(() => parseBillableChargesJson("{}"), /must contain a JSON array/);
  assert.throws(
    () => parseBillableChargesJson(JSON.stringify([charge(), charge()])),
    /appears more than once/,
  );
  assert.throws(
    () => parseBillableChargesJson(JSON.stringify([charge({ quantity: "0" })])),
    /non-positive quantity/,
  );
  assert.throws(
    () => parseBillableChargesJson(JSON.stringify([charge({ amount: "1.00001" })])),
    /loses precision beyond 4 decimal places/,
  );
});

test("billable-timesheet source rows link to exact sales-order lines and preserve ticket lineage", () => {
  const charges = [
    charge({
      sourceId: "100",
      sourceDocumentRef: "562976",
      amount: "285.00",
      quantity: "1.00",
      unitPrice: "285.00",
      occurredOn: "2026-04-04",
    }),
    charge({
      sourceId: "101",
      sourceDocumentRef: "562976",
      amount: "285.00",
      quantity: "1.00",
      unitPrice: "285.00",
      occurredOn: "2026-04-04",
    }),
  ];
  const nativeLines: SourceChargeLine[] = [
    {
      id: "line-a",
      sourceDocumentRef: "562976",
      itemRef: "2461",
      amount: "285.0000",
      quantity: "1.00000000",
      occurredOn: "2026-04-04",
      fieldTicketId: null,
    },
    {
      id: "line-b",
      sourceDocumentRef: "562976",
      itemRef: "2461",
      amount: "285.0000",
      quantity: "1.00000000",
      occurredOn: "2026-04-04",
      fieldTicketId: "ticket-a",
    },
  ];
  assert.deepEqual(
    matchBillableChargeLines(charges, nativeLines, new Map([["26684", "ticket-a"]])).map((link) => [
      link.sourceTransactionId,
      link.nativeLineId,
      link.previousTicketDocumentId,
    ]),
    [
      ["100", "line-a", null],
      ["101", "line-b", "ticket-a"],
    ],
  );
  assert.deepEqual(
    matchBillableChargeLines(
      [...charges].reverse(),
      [...nativeLines].reverse(),
      new Map([["26684", "ticket-a"]]),
    ),
    matchBillableChargeLines(charges, nativeLines, new Map([["26684", "ticket-a"]])),
  );
});

test("billable-timesheet linking refuses source ambiguity and missing native order lines", () => {
  const rows = [
    charge({ sourceId: "100", sourceDocumentRef: "SO1" }),
    charge({ sourceId: "101", sourceDocumentRef: "SO1", ticketRef: "26685" }),
  ];
  const line: SourceChargeLine = {
    id: "line-a",
    sourceDocumentRef: "SO1",
    itemRef: "2461",
    amount: "95.0000",
    quantity: "1.00000000",
    occurredOn: "2026-08-22",
    fieldTicketId: null,
  };
  assert.throws(
    () =>
      matchBillableChargeLines(
        rows,
        [line, { ...line, id: "line-b" }],
        new Map([
          ["26684", "ticket-a"],
          ["26685", "ticket-b"],
        ]),
      ),
    /multiple tickets/,
  );
  assert.throws(
    () =>
      matchBillableChargeLines(
        [charge({ sourceDocumentRef: "SO1" })],
        [],
        new Map([["26684", "ticket-a"]]),
      ),
    /counts differ/,
  );
  assert.throws(
    () => matchBillableChargeLines([charge({ sourceDocumentRef: "SO1" })], [line], new Map()),
    /no imported native field ticket/,
  );
  assert.throws(
    () =>
      matchBillableChargeLines(
        [charge({ sourceDocumentRef: "SO1" })],
        [{ ...line, fieldTicketId: "other-ticket" }],
        new Map([["26684", "ticket-a"]]),
      ),
    /already linked to a different field ticket/,
  );
});

test("billable source input rejects negative sub-money-scale values and impossible work dates", () => {
  for (const invalid of [
    charge({ quantity: "-0.00000001" }),
    charge({ unitPrice: "-0.00000001" }),
    charge({ occurredOn: "2026-02-30" }),
  ]) {
    assert.throws(
      () => parseBillableChargesJson(JSON.stringify([invalid])),
      /non-positive quantity|invalid work date/,
    );
  }
});

test("financial source mutations require a native draft without bypassing lifecycle guards", () => {
  assert.doesNotThrow(() => assertChargeWriteAllowed("draft", "100"));
  for (const status of ["approved", "posted", "voided", "pending", "unknown"]) {
    assert.throws(() => assertChargeWriteAllowed(status, "100"), /preserve its financial facts/);
  }
});
