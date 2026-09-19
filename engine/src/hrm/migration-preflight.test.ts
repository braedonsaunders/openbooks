import assert from "node:assert/strict";
import test from "node:test";
import {
  fingerprintSourceRow,
  preflightEmploymentMigration,
  type PreflightReport,
  type SourcePersonRow,
} from "./migration-preflight.ts";

const ORG = "org-test-001";
const NS = "legacy-extract";
const SUB_A = "sub-active-001";
const SUB_B = "sub-active-002";

function facts() {
  return [
    { id: SUB_A, orgId: ORG, isActive: true, isEliminated: false },
    { id: SUB_B, orgId: ORG, isActive: true, isEliminated: false },
  ];
}

function baseRow(overrides: Partial<SourcePersonRow> = {}): SourcePersonRow {
  return {
    orgId: ORG,
    sourceNamespace: NS,
    sourceId: "person-001",
    nativePartyId: "party-001",
    sourceVersion: "extract-2026-09-01",
    party: {
      kind: "employee",
      isActive: true,
      subsidiaryId: SUB_A,
      sourceIsNew: false,
      evidenceIds: ["party-ev-1"],
    },
    employer: {
      assertedSubsidiaryId: SUB_A,
      subsidiaryFacts: facts(),
      historicSubsidiaryIds: [],
    },
    role: {
      present: true,
      isActive: true,
      hiredOn: "2022-03-14",
      terminatedOn: null,
      dateProvenance: "role-ev-hire",
      countryContext: "CTX-1",
      evidenceIds: ["role-ev-1"],
    },
    payroll: {
      present: true,
      isActive: true,
      subsidiaryId: SUB_A,
      countryContext: "CTX-1",
      evidenceIds: ["pay-ev-1"],
    },
    observation: null,
    resolution: null,
    existingBinding: null,
    ...overrides,
  };
}

function onlyRow(report: PreflightReport) {
  assert.equal(report.rows.length, 1);
  return report.rows[0]!;
}

test("ready via role service dates with valid employer; candidate null without observation", () => {
  const row = onlyRow(preflightEmploymentMigration([baseRow()]));
  assert.equal(row.classification, "ready");
  assert.deepEqual(row.issues, []);
  assert.equal(row.candidate, null);
});

test("known service start never overstates history: coverage unknown, start precise", () => {
  const row = onlyRow(preflightEmploymentMigration([baseRow()]));
  assert.equal(row.historicalCoverage, "unknown");
  assert.equal(row.serviceStart, "2022-03-14");
  assert.equal(row.serviceStartProvenance, "role-ev-hire");
});

test("ready terminated episode with valid service dates", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({ role: { ...baseRow().role!, isActive: false, terminatedOn: "2024-06-30" } }),
    ]),
  );
  assert.equal(row.classification, "ready");
  assert.ok(!row.issues.some((issue) => issue.code === "missing_termination_date"));
});

test("same-day hire plus termination is valid: event dates are not interval endpoints", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({ role: { ...baseRow().role!, isActive: false, hiredOn: "2024-06-30", terminatedOn: "2024-06-30" } }),
    ]),
  );
  assert.equal(row.classification, "ready");
});

test("unknown employer refuses; null subsidiary is UNKNOWN never org root", () => {
  const row = onlyRow(
    preflightEmploymentMigration([baseRow({ employer: { ...baseRow().employer, assertedSubsidiaryId: null } })]),
  );
  assert.equal(row.classification, "unknown_employer");
  assert.ok(row.issues.some((issue) => issue.code === "unknown_employer"));
  assert.match(row.issues[0]!.detail, /UNKNOWN/);
});

test("operator mapping resolves unknown employer to ready", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        employer: { ...baseRow().employer, assertedSubsidiaryId: null },
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: SUB_A,
          hiredOn: null,
          terminatedOn: null,
          approvedBy: "op-7",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "transfer letter filed",
        },
      }),
    ]),
  );
  assert.equal(row.classification, "ready");
});

test("invalid employer: unknown reference, cross-org, inactive, eliminated", () => {
  const variants: Array<[string, SourcePersonRow]> = [
    ["unknown reference", baseRow({ employer: { ...baseRow().employer, assertedSubsidiaryId: "sub-ghost" } })],
    [
      "cross-org",
      baseRow({
        employer: {
          ...baseRow().employer,
          assertedSubsidiaryId: "sub-foreign",
          subsidiaryFacts: [...facts(), { id: "sub-foreign", orgId: "org-other", isActive: true, isEliminated: false }],
        },
      }),
    ],
    [
      "inactive",
      baseRow({
        employer: {
          assertedSubsidiaryId: "sub-dead",
          subsidiaryFacts: [...facts(), { id: "sub-dead", orgId: ORG, isActive: false, isEliminated: false }],
          historicSubsidiaryIds: [],
        },
      }),
    ],
    [
      "eliminated",
      baseRow({
        employer: {
          assertedSubsidiaryId: "sub-gone",
          subsidiaryFacts: [...facts(), { id: "sub-gone", orgId: ORG, isActive: true, isEliminated: true }],
          historicSubsidiaryIds: [],
        },
      }),
    ],
  ];
  for (const [label, row] of variants) {
    const result = onlyRow(preflightEmploymentMigration([row]));
    assert.equal(result.classification, "invalid_employer", label);
  }
});

test("parties.kind employee alone proves nothing: insufficient evidence", () => {
  const row = onlyRow(
    preflightEmploymentMigration([baseRow({ role: null, payroll: null, observation: null })]),
  );
  assert.equal(row.classification, "insufficient_employment_evidence");
});

test("flags-only role refuses: history cannot come from current flags", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: { present: true, isActive: true, hiredOn: null, terminatedOn: null, dateProvenance: null, countryContext: null, evidenceIds: ["r"] },
        payroll: null,
        observation: null,
      }),
    ]),
  );
  assert.equal(row.classification, "insufficient_employment_evidence");
  assert.ok(row.issues.some((issue) => issue.code === "flags_only_role"));
});

test("role-less payroll is a retained evidence case, never silently skipped", () => {
  const report = preflightEmploymentMigration([baseRow({ role: null })]);
  assert.equal(report.rows.length, 1);
  const row = report.rows[0]!;
  assert.equal(row.classification, "requires_review");
  assert.ok(row.issues.some((issue) => issue.code === "roleless_payroll_evidence"));
});

test("role-less payroll with current observation readies with unknown coverage plus note", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
      }),
    ]),
  );
  assert.equal(row.classification, "ready");
  assert.equal(row.historicalCoverage, "unknown");
  assert.ok(row.notes.some((note) => note.code === "roleless_payroll_evidence"));
  assert.ok(row.notes.some((note) => note.code === "service_start_unknown"));
  assert.equal(row.candidate?.serviceStart, null);
  assert.equal(row.candidate?.effectiveFrom, "2026-09-01");
});

test("observation never backfills hired_on: serviceStart stays null", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: { present: true, isActive: true, hiredOn: null, terminatedOn: null, dateProvenance: null, countryContext: null, evidenceIds: ["r"] },
        payroll: null,
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
      }),
    ]),
  );
  assert.equal(row.classification, "ready");
  assert.equal(row.historicalCoverage, "unknown");
  assert.equal(row.candidate?.serviceStart, null);
  assert.equal(row.candidate?.serviceStartProvenance, null);
});

test("draft suspect forces review and is never erased", () => {
  const report = preflightEmploymentMigration([
    baseRow({
      party: { ...baseRow().party, isActive: false, sourceIsNew: true },
      payroll: null,
    }),
  ]);
  assert.equal(report.rows.length, 1);
  const row = report.rows[0]!;
  assert.equal(row.classification, "requires_review");
  assert.ok(row.issues.some((issue) => issue.code === "draft_suspect"));
});

test("mapped historic stub is a transfer note; unmapped stub needs review, current stands", () => {
  const mapped = onlyRow(
    preflightEmploymentMigration([
      baseRow({ employer: { ...baseRow().employer, historicSubsidiaryIds: [SUB_B] } }),
    ]),
  );
  assert.equal(mapped.classification, "ready");
  assert.ok(mapped.notes.some((note) => note.code === "historic_employer_transfer"));

  const unmapped = onlyRow(
    preflightEmploymentMigration([
      baseRow({ employer: { ...baseRow().employer, historicSubsidiaryIds: ["sub-ancient"] } }),
    ]),
  );
  assert.equal(unmapped.classification, "requires_review");
  assert.ok(unmapped.issues.some((issue) => issue.code === "unresolved_historic_employer"));
});

test("malformed and contradictory service dates refuse as ambiguous", () => {
  const malformed = onlyRow(
    preflightEmploymentMigration([
      baseRow({ role: { ...baseRow().role!, hiredOn: "2022-13-40" } }),
    ]),
  );
  assert.equal(malformed.classification, "ambiguous");
  assert.ok(malformed.issues.some((issue) => issue.code === "invalid_service_date"));

  const inverted = onlyRow(
    preflightEmploymentMigration([
      baseRow({ role: { ...baseRow().role!, hiredOn: "2024-01-01", terminatedOn: "2023-01-01" } }),
    ]),
  );
  assert.equal(inverted.classification, "ambiguous");
  assert.ok(inverted.issues.some((issue) => issue.code === "contradictory_service_dates"));
});

test("bare inactive flag demands no fabricated terminated_on; observed on_leave stays unknown", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: { ...baseRow().role!, isActive: false, hiredOn: "2022-03-14", terminatedOn: null },
        observation: { status: "on_leave", observedAt: "2026-09-01T00:00:00Z", provenance: "op-3" },
      }),
    ]),
  );
  assert.equal(row.classification, "ready");
  assert.ok(!row.issues.some((issue) => issue.code === "missing_termination_date"));
  assert.equal(row.candidate?.status, "on_leave");
});

test("observed termination without a termination date needs review", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: { ...baseRow().role!, isActive: false, hiredOn: "2022-03-14", terminatedOn: null },
        observation: { status: "terminated", observedAt: "2026-09-01T00:00:00Z", provenance: "op-3" },
      }),
    ]),
  );
  assert.equal(row.classification, "requires_review");
  assert.ok(row.issues.some((issue) => issue.code === "missing_termination_date"));
  assert.equal(row.candidate, null);
});

test("conflicting mappings refuse as ambiguous", () => {
  const resolutionConflict = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: SUB_B,
          hiredOn: null,
          terminatedOn: null,
          approvedBy: "op-7",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "claims transfer",
        },
      }),
    ]),
  );
  assert.equal(resolutionConflict.classification, "ambiguous");
  assert.ok(resolutionConflict.issues.some((issue) => issue.code === "conflicting_employer_mapping"));

  const partyMismatch = onlyRow(
    preflightEmploymentMigration([baseRow({ party: { ...baseRow().party, subsidiaryId: SUB_B } })]),
  );
  assert.equal(partyMismatch.classification, "ambiguous");
  assert.ok(partyMismatch.issues.some((issue) => issue.code === "party_employer_mismatch"));

  const scheduleConflict = onlyRow(
    preflightEmploymentMigration([
      baseRow({ payroll: { ...baseRow().payroll!, subsidiaryId: SUB_B } }),
    ]),
  );
  assert.equal(scheduleConflict.classification, "ambiguous");
  assert.ok(scheduleConflict.issues.some((issue) => issue.code === "schedule_employer_conflict"));

  const countryConflict = onlyRow(
    preflightEmploymentMigration([
      baseRow({ payroll: { ...baseRow().payroll!, countryContext: "CTX-2" } }),
    ]),
  );
  assert.equal(countryConflict.classification, "ambiguous");
  assert.ok(countryConflict.issues.some((issue) => issue.code === "country_context_conflict"));
});

test("duplicate (org, namespace, sourceId) variants are all retained and refused", () => {
  const first = baseRow();
  const second = baseRow({ nativePartyId: "party-002" });
  const report = preflightEmploymentMigration([first, second]);
  assert.equal(report.rows.length, 2);
  for (const row of report.rows) {
    assert.equal(row.classification, "ambiguous");
    assert.ok(row.issues.some((issue) => issue.code === "duplicate_source_key"));
  }
  assert.equal(report.counts.ambiguous, 2);
});

test("same sourceId in another namespace is not a duplicate", () => {
  const report = preflightEmploymentMigration([
    baseRow(),
    baseRow({ sourceNamespace: "hris-extract", nativePartyId: "party-002" }),
  ]);
  assert.equal(report.counts.ready, 2);
});

function bindingFor(row: SourcePersonRow, employmentId: string) {
  return {
    canonicalOrgId: row.orgId,
    canonicalWorkerPartyId: row.nativePartyId,
    canonicalEmployerSubsidiaryId: SUB_A,
    canonicalEmploymentId: employmentId,
    sourceFingerprint: fingerprintSourceRow(row),
    sourceVersion: row.sourceVersion,
    boundAt: "2026-09-11T00:00:00Z",
    provenance: "bind-ev",
  };
}

test("consistent binding migrates; no binding never counts as migrated", () => {
  const template = baseRow({ sourceId: "bound-1" });
  const migrated = onlyRow(
    preflightEmploymentMigration([{ ...template, existingBinding: bindingFor(template, "emp-1") }]),
  );
  assert.equal(migrated.classification, "already_migrated");

  const unbound = onlyRow(preflightEmploymentMigration([template]));
  assert.equal(unbound.classification, "ready");
  assert.notEqual(unbound.classification, "already_migrated");
});

test("duplicate outranks even a consistent binding", () => {
  const template = baseRow({ sourceId: "dup-bound", nativePartyId: "party-A" });
  const bound = { ...template, existingBinding: bindingFor(template, "emp-A") };
  const report = preflightEmploymentMigration([bound, { ...template, nativePartyId: "party-B" }]);
  assert.equal(report.rows.length, 2);
  for (const row of report.rows) {
    assert.equal(row.classification, "ambiguous");
    assert.ok(row.issues.some((issue) => issue.code === "duplicate_source_key"));
  }
});

test("binding consistency is proven from input: fingerprint and version drift refuse", () => {
  const template = baseRow({ sourceId: "bind-check" });
  const stale = onlyRow(
    preflightEmploymentMigration([
      {
        ...template,
        existingBinding: {
          canonicalOrgId: ORG,
          canonicalWorkerPartyId: template.nativePartyId,
          canonicalEmployerSubsidiaryId: SUB_A,
          canonicalEmploymentId: "emp-1",
          sourceFingerprint: "deadbeef",
          sourceVersion: template.sourceVersion,
          boundAt: "2026-09-11T00:00:00Z",
          provenance: "bind-ev",
        },
      },
    ]),
  );
  assert.equal(stale.classification, "binding_conflict");

  const versionDrift = onlyRow(
    preflightEmploymentMigration([
      {
        ...template,
        sourceVersion: "extract-2026-10-01",
        existingBinding: {
          canonicalOrgId: ORG,
          canonicalWorkerPartyId: template.nativePartyId,
          canonicalEmployerSubsidiaryId: SUB_A,
          canonicalEmploymentId: "emp-1",
          sourceFingerprint: "deadbeef",
          sourceVersion: "extract-2026-09-01",
          boundAt: "2026-09-11T00:00:00Z",
          provenance: "bind-ev",
        },
      },
    ]),
  );
  assert.equal(versionDrift.classification, "binding_conflict");
});

test("empty inventory reports empty_not_evaluated, never a clean claim", () => {
  const report = preflightEmploymentMigration([]);
  assert.equal(report.status, "empty_not_evaluated");
  assert.deepEqual(report.rows, []);
  for (const code of Object.keys(report.counts)) {
    assert.equal(report.counts[code as keyof typeof report.counts], 0);
  }
});

test("input-order invariance: shuffle preserves rows, counts, and order", () => {
  const batch: SourcePersonRow[] = [
    baseRow(),
    baseRow({ sourceId: "person-002", employer: { ...baseRow().employer, assertedSubsidiaryId: null } }),
    baseRow({ sourceId: "person-003", role: null, payroll: null }),
    baseRow({ sourceId: "person-004", orgId: "org-a", employer: { assertedSubsidiaryId: SUB_A, subsidiaryFacts: [{ id: SUB_A, orgId: "org-a", isActive: true, isEliminated: false }], historicSubsidiaryIds: [] }, party: { ...baseRow().party, subsidiaryId: SUB_A } }),
    baseRow({ sourceId: "person-005", sourceNamespace: "a-namespace" }),
  ];
  const forward = preflightEmploymentMigration(batch);
  const backward = preflightEmploymentMigration([...batch].reverse());
  assert.deepEqual(backward, forward);
  const sortedKeys = forward.rows.map((row) => `${row.orgId}${row.sourceNamespace}${row.sourceId}`);
  assert.deepEqual(sortedKeys, [...sortedKeys].sort());
  const total = Object.values(forward.counts).reduce((sum, count) => sum + count, 0);
  assert.equal(total, forward.rows.length);
});

test("input is never mutated: frozen batch classifies cleanly", () => {
  const batch: SourcePersonRow[] = [baseRow(), baseRow({ sourceId: "person-002" })];
  const snapshot = structuredClone(batch);
  const deepFreeze = (value: unknown): void => {
    if (typeof value === "object" && value !== null) {
      for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
      Object.freeze(value);
    }
  };
  deepFreeze(batch);
  const report = preflightEmploymentMigration(batch);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(batch, snapshot);
});

test("multiple issues retained with deterministic primary for counts", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        employer: { ...baseRow().employer, assertedSubsidiaryId: null },
        role: null,
        payroll: null,
      }),
    ]),
  );
  assert.ok(row.issues.length >= 2);
  assert.equal(row.classification, "unknown_employer");
});

test("incomplete operator mapping contributes nothing and needs review", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        employer: { ...baseRow().employer, assertedSubsidiaryId: null },
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: SUB_A,
          hiredOn: null,
          terminatedOn: null,
          approvedBy: "",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "transfer letter filed",
        },
      }),
    ]),
  );
  assert.ok(row.issues.some((issue) => issue.code === "incomplete_resolution_evidence"));
  assert.equal(row.classification, "unknown_employer");
});

test("canonical observation vocabulary: non-canonical status refuses", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        observation: { status: "employed" as never, observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
      }),
    ]),
  );
  assert.equal(row.classification, "ambiguous");
  assert.ok(row.issues.some((issue) => issue.code === "invalid_observation_status"));
});

test("terminated observation without a termination date needs review with or without a role", () => {
  const roleless = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        payroll: null,
        observation: { status: "terminated", observedAt: "2026-08-15T00:00:00Z", provenance: "op-9" },
      }),
    ]),
  );
  assert.equal(roleless.classification, "requires_review");
  assert.ok(roleless.issues.some((issue) => issue.code === "missing_termination_date"));
  assert.equal(roleless.candidate, null);
  assert.equal(roleless.historicalCoverage, "unknown");

  const rolelessPayroll = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        observation: { status: "terminated", observedAt: "2026-08-15T00:00:00Z", provenance: "op-9" },
      }),
    ]),
  );
  assert.equal(rolelessPayroll.classification, "requires_review");
  assert.ok(rolelessPayroll.issues.some((issue) => issue.code === "missing_termination_date"));
  assert.equal(rolelessPayroll.candidate, null);
});

test("role-less terminated observation with a mapped termination date readies", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        payroll: null,
        observation: { status: "terminated", observedAt: "2026-08-15T00:00:00Z", provenance: "op-9" },
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: null,
          hiredOn: null,
          terminatedOn: "2026-08-10",
          approvedBy: "op-7",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "release record",
        },
      }),
    ]),
  );
  assert.equal(row.classification, "ready");
  assert.equal(row.historicalCoverage, "unknown");
  assert.equal(row.candidate?.status, "terminated");
  assert.equal(row.candidate?.effectiveFrom, "2026-08-15");
  assert.ok(!row.issues.some((issue) => issue.code === "missing_termination_date"));
});

test("already_migrated retains other issues instead of short-circuiting", () => {
  const template = baseRow({
    sourceId: "bound-notes",
    employer: { ...baseRow().employer, historicSubsidiaryIds: ["sub-ancient"] },
  });
  const row = onlyRow(
    preflightEmploymentMigration([{ ...template, existingBinding: bindingFor(template, "emp-9") }]),
  );
  assert.equal(row.classification, "already_migrated");
  assert.ok(row.issues.some((issue) => issue.code === "unresolved_historic_employer"));
});

test("source fingerprint is SHA256, stable, and sensitive to change", () => {
  const first = baseRow({ sourceId: "fp-1" });
  const identical = baseRow({ sourceId: "fp-1" });
  const fingerprint = fingerprintSourceRow(first);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprintSourceRow(identical), fingerprint);
  const changed = baseRow({ sourceId: "fp-1", party: { ...baseRow().party, isActive: false } });
  assert.notEqual(fingerprintSourceRow(changed), fingerprint);
});

test("duplicate variants differing only in observation sort identically under reversal", () => {
  const template = baseRow({ sourceId: "obs-dup", role: null, payroll: null });
  const active = { ...template, observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" } } as SourcePersonRow;
  const onLeave = { ...template, observation: { status: "on_leave", observedAt: "2026-09-02T00:00:00Z", provenance: "op-2" } } as SourcePersonRow;
  assert.equal(fingerprintSourceRow(active), fingerprintSourceRow(onLeave));
  const forward = preflightEmploymentMigration([active, onLeave]);
  const backward = preflightEmploymentMigration([onLeave, active]);
  assert.deepEqual(backward, forward);
  assert.equal(forward.rows.length, 2);
});

test("conflicting subsidiary facts refuse regardless of fact order", () => {
  const activeFact = { id: SUB_A, orgId: ORG, isActive: true, isEliminated: false };
  const inactiveFact = { id: SUB_A, orgId: ORG, isActive: false, isEliminated: false };
  const template = baseRow({ sourceId: "fact-conflict" });
  const firstOrder = { ...template, employer: { ...template.employer, subsidiaryFacts: [activeFact, inactiveFact] } };
  const secondOrder = { ...template, employer: { ...template.employer, subsidiaryFacts: [inactiveFact, activeFact] } };
  const forward = preflightEmploymentMigration([firstOrder]);
  const backward = preflightEmploymentMigration([secondOrder]);
  assert.deepEqual(backward, forward);
  const row = forward.rows[0]!;
  assert.equal(row.classification, "ambiguous");
  assert.ok(row.issues.some((issue) => issue.code === "conflicting_subsidiary_evidence"));
  assert.equal(row.candidate, null);
});

test("invalid employer with a valid observation emits no candidate", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        employer: {
          assertedSubsidiaryId: "sub-dead",
          subsidiaryFacts: [...facts(), { id: "sub-dead", orgId: ORG, isActive: false, isEliminated: false }],
          historicSubsidiaryIds: [],
        },
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
      }),
    ]),
  );
  assert.equal(row.classification, "invalid_employer");
  assert.equal(row.candidate, null);
});

test("blocked rows with observations emit no candidate", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        employer: { ...baseRow().employer, historicSubsidiaryIds: ["sub-ancient"] },
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
      }),
    ]),
  );
  assert.equal(row.classification, "requires_review");
  assert.equal(row.candidate, null);
});

test("source-versus-mapping date conflict refuses instead of preferring a side", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: null,
          hiredOn: "2021-01-05",
          terminatedOn: null,
          approvedBy: "op-7",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "signed offer letter",
        },
      }),
    ]),
  );
  assert.equal(row.classification, "ambiguous");
  assert.ok(row.issues.some((issue) => issue.code === "conflicting_service_dates"));
  assert.equal(row.serviceStart, null);
});

test("mapped terminated_on is consumed: mapped end before source start contradicts", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: { ...baseRow().role!, hiredOn: "2022-03-14", terminatedOn: null },
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: null,
          hiredOn: null,
          terminatedOn: "2021-12-31",
          approvedBy: "op-7",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "release record",
        },
      }),
    ]),
  );
  assert.equal(row.classification, "ambiguous");
  assert.ok(row.issues.some((issue) => issue.code === "contradictory_service_dates"));
});

test("binding-conflict remedy preserves the prior binding, never erases it", () => {
  const template = baseRow({ sourceId: "bind-remedy" });
  const row = onlyRow(
    preflightEmploymentMigration([
      {
        ...template,
        existingBinding: {
          canonicalOrgId: ORG,
          canonicalWorkerPartyId: template.nativePartyId,
          canonicalEmployerSubsidiaryId: SUB_A,
          canonicalEmploymentId: "emp-1",
          sourceFingerprint: "0".repeat(64),
          sourceVersion: template.sourceVersion,
          boundAt: "2026-09-11T00:00:00Z",
          provenance: "bind-ev",
        },
      },
    ]),
  );
  assert.equal(row.classification, "binding_conflict");
  const remedy = row.issues[0]!.remedy;
  assert.match(remedy, /preserve the prior binding/i);
  assert.match(remedy, /never erase it/i);
  assert.ok(!/retire the/i.test(remedy));
});

test("provenance aggregates evidence identifiers deterministically", () => {
  const row = onlyRow(preflightEmploymentMigration([baseRow()]));
  assert.deepEqual(row.provenance, [...row.provenance].sort());
  assert.ok(row.provenance.includes("party-ev-1"));
  assert.ok(row.provenance.includes("role-ev-hire"));
  assert.ok(row.provenance.includes("pay-ev-1"));
});

test("output carries no PII-shaped payload", () => {
  const report = preflightEmploymentMigration([baseRow()]);
  const text = JSON.stringify(report);
  assert.ok(!text.includes("salary"));
  assert.ok(!text.includes("sin_encrypted"));
  assert.ok(!text.includes("address"));
});

test("whitespace-only observation provenance refuses; it never reads as ready", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        payroll: null,
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "   " },
      }),
    ]),
  );
  assert.equal(row.classification, "ambiguous");
  assert.ok(row.issues.some((issue) => issue.code === "invalid_observation_evidence"));
  assert.equal(row.candidate, null);
});

test("whitespace-only identity refuses and keys are never silently trimmed", () => {
  const blank = onlyRow(preflightEmploymentMigration([baseRow({ sourceId: "   " })]));
  assert.equal(blank.classification, "ambiguous");
  assert.ok(blank.issues.some((issue) => issue.code === "invalid_source_identity"));
  assert.equal(blank.candidate, null);

  const blankVersion = onlyRow(
    preflightEmploymentMigration([baseRow({ sourceId: "ver-blank", sourceVersion: "  " })]),
  );
  assert.ok(blankVersion.issues.some((issue) => issue.code === "invalid_source_identity"));

  const report = preflightEmploymentMigration([
    baseRow({ sourceId: " a" }),
    baseRow({ sourceId: "a" }),
  ]);
  assert.equal(report.rows.length, 2);
  assert.ok(!report.rows.some((row) => row.issues.some((issue) => issue.code === "duplicate_source_key")));
});

test("whitespace-only binding provenance is a binding conflict, never migrated", () => {
  const template = baseRow({ sourceId: "bind-blank-prov" });
  const row = onlyRow(
    preflightEmploymentMigration([
      {
        ...template,
        existingBinding: { ...bindingFor(template, "emp-1"), provenance: "   " },
      },
    ]),
  );
  assert.equal(row.classification, "binding_conflict");
  assert.ok(row.issues.some((issue) => issue.code === "binding_conflict"));
});

test("whitespace-only operator approver or rationale is incomplete mapping evidence", () => {
  const variants = [
    { approvedBy: "   ", rationale: "transfer letter filed" },
    { approvedBy: "op-7", rationale: "\t " },
  ];
  for (const [approvedBy, rationale] of variants.map((variant) => [variant.approvedBy, variant.rationale] as const)) {
    const row = onlyRow(
      preflightEmploymentMigration([
        baseRow({
          resolution: {
            kind: "operator-employer-date-mapping",
            employerSubsidiaryId: null,
            hiredOn: null,
            terminatedOn: null,
            approvedBy,
            approvedAt: "2026-09-10T12:00:00Z",
            rationale,
          },
        }),
      ]),
    );
    assert.ok(row.issues.some((issue) => issue.code === "incomplete_resolution_evidence"));
    assert.equal(row.classification, "requires_review");
  }
});

test("whitespace-only hire-date provenance needs review instead of anchoring history", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({ role: { ...baseRow().role!, dateProvenance: "  " } }),
    ]),
  );
  assert.ok(row.issues.some((issue) => issue.code === "missing_service_date_provenance"));
  assert.equal(row.serviceStart, null);
  assert.equal(row.classification, "requires_review");
});

test("mapped service dates are preserved without a role", () => {
  const mapping = {
    kind: "operator-employer-date-mapping",
    employerSubsidiaryId: null,
    hiredOn: "2022-01-01",
    terminatedOn: null,
    approvedBy: "op-7",
    approvedAt: "2026-09-10T12:00:00Z",
    rationale: "signed offer letter",
  } as const;
  const bare = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        payroll: null,
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
        resolution: { ...mapping },
      }),
    ]),
  );
  assert.equal(bare.classification, "ready");
  assert.equal(bare.serviceStart, "2022-01-01");
  assert.equal(bare.serviceStartProvenance, "operator-employer-date-mapping");
  assert.equal(bare.candidate?.serviceStart, "2022-01-01");
  assert.equal(bare.historicalCoverage, "unknown");

  const withPayroll = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
        resolution: { ...mapping },
      }),
    ]),
  );
  assert.equal(withPayroll.classification, "ready");
  assert.equal(withPayroll.serviceStart, "2022-01-01");
  assert.ok(!withPayroll.notes.some((note) => note.code === "service_start_unknown"));
});

test("contradictory mapped dates are refused without a role", () => {
  const row = onlyRow(
    preflightEmploymentMigration([
      baseRow({
        role: null,
        payroll: null,
        observation: { status: "active", observedAt: "2026-09-01T00:00:00Z", provenance: "op-1" },
        resolution: {
          kind: "operator-employer-date-mapping",
          employerSubsidiaryId: null,
          hiredOn: "2022-01-01",
          terminatedOn: "2021-12-31",
          approvedBy: "op-7",
          approvedAt: "2026-09-10T12:00:00Z",
          rationale: "conflicting records",
        },
      }),
    ]),
  );
  assert.ok(row.issues.some((issue) => issue.code === "incomplete_resolution_evidence"));
  assert.notEqual(row.classification, "ready");
  assert.equal(row.candidate, null);
});
