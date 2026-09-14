import assert from "node:assert/strict";
import test from "node:test";
import { parseRoeIssueParam } from "./filings.ts";
import { PayrollError } from "../../payroll-error.ts";

/**
 * The ROE issue-selection parser fails closed on every malformed input.
 *
 * The surface sends `employees=<uuid>:<reason>[:<encoded comment>],…` in a
 * POST body and this parser owns the contract. A comment carrying a bare `%`
 * (or any malformed escape) used to escape as a URIError — past the route's
 * PayrollError catch and into a 500 — instead of the named 422 every other
 * malformed selection gets.
 */

const EMPLOYEE = "11111111-1111-4111-8111-111111111111";

test("a well-formed selection with an encoded comment parses", () => {
  const [issue] = parseRoeIssueParam(`${EMPLOYEE}:K:quit%2C%20moved%20away`);
  assert.equal(issue?.employeePartyId, EMPLOYEE);
  assert.equal(issue?.reasonCode, "K");
  assert.equal(issue?.comment, "quit, moved away");
});

test("a malformed escape is an invalid selection, not an unhandled throw", () => {
  assert.throws(
    () => parseRoeIssueParam(`${EMPLOYEE}:K:100% shortage`),
    (error: unknown) =>
      error instanceof PayrollError && /invalid employee selection/.test(error.message),
  );
});

test("a truncated escape is an invalid selection, not an unhandled throw", () => {
  assert.throws(
    () => parseRoeIssueParam(`${EMPLOYEE}:E:done%E0%A4%A`),
    (error: unknown) =>
      error instanceof PayrollError && /invalid employee selection/.test(error.message),
  );
});

test("an overlong decoded comment is still refused by name", () => {
  assert.throws(
    () => parseRoeIssueParam(`${EMPLOYEE}:K:${"x".repeat(501)}`),
    /comment too long/,
  );
});
