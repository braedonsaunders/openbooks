import assert from "node:assert/strict";
import test from "node:test";
import { parseReportQuery } from "./report-filters";
import {
  ReportSubsidiarySelectionError,
  selectReportSubsidiary,
} from "./report-subsidiary-selection";

const root = "01a13870-1111-7000-8000-111111111111";
const own = "01a13870-2222-7000-8000-222222222222";
const foreign = "01a13870-3333-7000-8000-333333333333";
const inactive = "01a13870-4444-7000-8000-444444444444";
const elimination = "01a13870-5555-7000-8000-555555555555";
const options = [
  { id: root, parentId: null, isActive: true, isElimination: false },
  { id: own, parentId: root, isActive: true, isElimination: false },
  { id: foreign, parentId: root, isActive: true, isElimination: false },
  { id: inactive, parentId: root, isActive: false, isElimination: false },
  { id: elimination, parentId: root, isActive: true, isElimination: true },
];

test("an explicit unavailable entity never substitutes the first visible entity", () => {
  for (const requested of [
    foreign,
    root,
    inactive,
    elimination,
    "01a13870-9999-7000-8000-999999999999",
  ]) {
    assert.throws(
      () => selectReportSubsidiary(requested, options, new Set([own])),
      (error) => {
        assert.ok(error instanceof ReportSubsidiarySelectionError);
        assert.equal(error.status, 404);
        assert.ok(!error.message.includes(requested));
        return true;
      },
    );
  }
  assert.throws(
    () => selectReportSubsidiary(own, options, new Set()),
    ReportSubsidiarySelectionError,
  );
});

test("only an omitted selection defaults, with empty scope retaining an empty population", () => {
  assert.equal(selectReportSubsidiary(undefined, options, null).node?.id, root);
  assert.equal(selectReportSubsidiary(undefined, options, new Set([own])).node?.id, own);
  assert.deepEqual(selectReportSubsidiary(undefined, options, new Set()), {
    options: [],
    node: undefined,
  });
});

test("explicit accessible entities retain exact identity, including a single-entity organization", () => {
  assert.equal(selectReportSubsidiary(foreign, options, null).node?.id, foreign);
  assert.equal(selectReportSubsidiary(own.toUpperCase(), options, new Set([own])).node?.id, own);
  assert.equal(selectReportSubsidiary(root, options.slice(0, 1), null).node?.id, root);
  assert.throws(
    () => selectReportSubsidiary(foreign, options.slice(0, 1), null),
    ReportSubsidiarySelectionError,
  );
  for (const requested of [inactive, elimination]) {
    assert.throws(
      () => selectReportSubsidiary(requested, options, null),
      ReportSubsidiarySelectionError,
    );
  }
});

test("report URL parsing preserves an explicit scope and refuses malformed scope instead of widening it", () => {
  assert.equal(parseReportQuery(new URLSearchParams({ sub: own })).subsidiaryId, own);
  assert.equal(
    selectReportSubsidiary(
      parseReportQuery({ sub: own.toUpperCase() }).subsidiaryId,
      options,
      new Set([own]),
    ).node?.id,
    own,
  );
  assert.equal(parseReportQuery(new URLSearchParams()).subsidiaryId, undefined);
  for (const sub of ["", "not-an-entity"]) {
    const query = parseReportQuery(new URLSearchParams({ sub }));
    assert.equal(query.subsidiaryId, sub);
    assert.throws(
      () => selectReportSubsidiary(query.subsidiaryId, options, null),
      ReportSubsidiarySelectionError,
    );
  }
});
