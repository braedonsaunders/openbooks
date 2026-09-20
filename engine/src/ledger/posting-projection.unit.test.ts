import assert from "node:assert/strict";
import test from "node:test";
import { sum } from "../money/money.ts";
import {
  buildProjection,
  glLineKey,
  glProjectionKey,
  glProjectionScopeUnchanged,
} from "./posting-projection.ts";
import {
  PostingError,
  type PostingDeps,
  type PostingDocument,
  type PostingDocumentLine,
} from "./posting-contracts.ts";

const deps = (): PostingDeps => ({
  control: { ar: "1100", ap: "2100", bank: "1000" },
});

const journalDoc = (): PostingDocument =>
  ({ kind: "journal" }) as unknown as PostingDocument;

const journalLine = (over: Record<string, unknown>): PostingDocumentLine =>
  ({ description: null, partyId: null, ...over }) as unknown as PostingDocumentLine;

const keyLine = (over: Record<string, unknown> = {}) => ({
  accountId: "1000",
  amount: "100.0000",
  ...over,
});

test("a balanced two-line journal projects to a balanced two-line entry", () => {
  const lines = buildProjection(
    journalDoc(),
    [journalLine({ accountId: "1000", amount: "100.0000" }), journalLine({ accountId: "2000", amount: "-100.0000" })],
    deps(),
  );
  assert.equal(lines.length, 2);
  assert.equal(sum(lines.map((l) => l.amount)), "0.0000");
  assert.deepEqual(lines.map((l) => l.accountId), ["1000", "2000"]);
});

test("an unknown document kind is refused by name", () => {
  const doc = ({ kind: "bond_yield_curve" }) as unknown as PostingDocument;
  assert.throws(
    () => buildProjection(doc, [], deps()),
    (e: unknown) =>
      e instanceof PostingError &&
      /no posting rule for document kind "bond_yield_curve"/.test(e.message),
  );
});

test("a projection with fewer than two surviving lines is refused", () => {
  // One nonzero journal line projects to exactly one kernel line: below the
  // two-line minimum, so the boundary (2, not 1) must refuse it.
  assert.throws(
    () =>
      buildProjection(
        journalDoc(),
        [journalLine({ accountId: "1000", amount: "50.0000" })],
        deps(),
      ),
    (e: unknown) =>
      e instanceof PostingError && /fewer than 2 lines/.test(e.message),
  );
});

test("an unbalanced rule result is refused, never posted lopsided", () => {
  assert.throws(
    () =>
      buildProjection(
        journalDoc(),
        [
          journalLine({ accountId: "1000", amount: "100.0000" }),
          journalLine({ accountId: "2000", amount: "-99.0000" }),
        ],
        deps(),
      ),
    (e: unknown) =>
      e instanceof PostingError && /does not balance/.test(e.message),
  );
});

test("an open-item leg without its party is refused", () => {
  // A customer invoice with no header party leaves the AR leg as an open
  // item with no customer: an anonymous subledger balance must fail closed.
  const doc = ({
    kind: "customer_invoice",
    partyId: null,
  }) as unknown as PostingDocument;
  assert.throws(
    () =>
      buildProjection(
        doc,
        [journalLine({ accountId: "4000", amount: "100.0000" })],
        deps(),
      ),
    (e: unknown) =>
      e instanceof PostingError && /has no party/.test(e.message),
  );
});

test("the comparison key normalizes amount scales", () => {
  assert.equal(glLineKey(keyLine({ amount: "100.00" })), glLineKey(keyLine({ amount: "100.0000" })));
});

test("dimension order and line order never change the projection key", () => {
  const a = keyLine({ extraDims: { b: "2", a: "1" } });
  const b = keyLine({ extraDims: { a: "1", b: "2" } });
  assert.equal(glLineKey(a), glLineKey(b));
  const other = keyLine({ accountId: "2000", amount: "-100.0000" });
  assert.equal(glProjectionKey([a, other]), glProjectionKey([other, a]));
});

test("the comparison key still separates account, direction, and open-item legs", () => {
  const base = glLineKey(keyLine());
  assert.notEqual(base, glLineKey(keyLine({ accountId: "2000" })));
  assert.notEqual(base, glLineKey(keyLine({ amount: "-100.0000" })));
  assert.notEqual(base, glLineKey(keyLine({ isOpenItem: true })));
});

test("projection scope changes only on period or posting date", () => {
  const scope = { periodId: "2026-09", postingDate: "2026-09-15" };
  assert.equal(glProjectionScopeUnchanged(scope, { ...scope }), true);
  assert.equal(
    glProjectionScopeUnchanged(scope, { ...scope, periodId: "2026-10" }),
    false,
  );
  assert.equal(
    glProjectionScopeUnchanged(scope, { ...scope, postingDate: "2026-09-16" }),
    false,
  );
});
