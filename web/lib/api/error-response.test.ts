import assert from "node:assert/strict";
import test from "node:test";
import { StoredValueError } from "@openbooks/engine/stored-value";
import { ConsolidationError } from "@openbooks/engine/consolidation/consolidation";
import { PostingError } from "@openbooks/engine/journal/contracts";
import { PeriodClosedError } from "@openbooks/engine/periods/period-policy";
import { apiErrorResponse } from "./error-response";
import { PdfLayoutError } from "@openbooks/pdf";
import { readApiErrorMessage } from "../api-error";

test("a stored-value refusal reaches the client with its remedy and affected field", async () => {
  const response = await apiErrorResponse(
    new StoredValueError({
      message: "Gift card GC-104 still has a balance",
      status: 409,
      code: "balance_not_zero",
      remedy: "Redeem or adjust the remaining balance before closing the account",
      field: "balance",
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.clone().json(), {
    error: "Gift card GC-104 still has a balance",
    code: "balance_not_zero",
    remedy: "Redeem or adjust the remaining balance before closing the account",
    field: "balance",
  });
  assert.equal(
    await readApiErrorMessage(response, "Close failed"),
    "Gift card GC-104 still has a balance — Redeem or adjust the remaining balance before closing the account",
  );
});

test("a typed refusal with no structured metadata keeps the established envelope", async () => {
  class Refusal extends Error {
    readonly status = 422;
  }
  const response = await apiErrorResponse(new Refusal("Select an active account"));
  assert.deepEqual(await response.json(), { error: "Select an active account" });
});

test("an unexpected error cannot publish forged refusal metadata", async (t) => {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const error = Object.assign(new Error("private database relation missing"), {
    status: 422,
    code: "private_code",
    remedy: "private recovery command",
    field: "private_column",
  });
  const response = await apiErrorResponse(error);
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.code, undefined);
  assert.equal(body.remedy, undefined);
  assert.equal(body.field, undefined);
  assert.doesNotMatch(body.error, /private/);
  assert.equal(typeof body.requestId, "string");
});

test("a status-less posting refusal answers 422 with its scope, never a 500", async () => {
  const scope = {
    kind: "period-closed" as const,
    periodId: "period-1",
    bookId: "book-1",
    subsidiaryId: null,
    module: "gl" as const,
  };
  const response = await apiErrorResponse(
    new PostingError("journal entry JE-1: GL is closed for this period", { details: scope }),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "journal entry JE-1: GL is closed for this period",
    code: "posting_refused",
    details: scope,
  });
});

test("a raw closed-period refusal answers 422 with its scope, never a 500", async () => {
  const scope = {
    kind: "period-closed" as const,
    periodId: "period-1",
    bookId: "book-1",
    subsidiaryId: "sub-1",
    module: "gl" as const,
  };
  const response = await apiErrorResponse(
    new PeriodClosedError("GL is closed for this period", scope),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "GL is closed for this period",
    code: "period-closed",
    details: scope,
  });
});

test("a consolidation period-closed refusal answers 422 with remedy and scope, never a 500", async () => {
  const scope = {
    kind: "period-closed" as const,
    periodId: "period-1",
    bookId: "book-1",
    subsidiaryId: null,
    module: "gl" as const,
  };
  const response = await apiErrorResponse(
    new ConsolidationError(
      "GL is closed for this period — consolidated exchange rates are close evidence",
      "period-closed",
      {
        remedy: "Request a controlled reopen of the period, then derive the rates again.",
        details: scope,
      },
    ),
  );
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "GL is closed for this period — consolidated exchange rates are close evidence",
    code: "period-closed",
    remedy: "Request a controlled reopen of the period, then derive the rates again.",
    details: scope,
  });
});

test("a non-period consolidation sibling still answers 500 without safeStatus", async (t) => {
  const original = console.error;
  console.error = () => {};
  t.after(() => {
    console.error = original;
  });
  const response = await apiErrorResponse(
    new ConsolidationError("period nope not found", "not-found"),
  );
  assert.equal(response.status, 500);
});

test("an unreadable PDF layout reaches the operator as a 422 with the supported print remedy", async () => {
  const response = await apiErrorResponse(new PdfLayoutError());
  assert.equal(response.status, 422);
  const body = await response.clone().json();
  assert.equal(body.code, "pdf_layout_too_narrow");
  assert.match(body.remedy, /wider page/);
  const displayed = await readApiErrorMessage(response, "Export failed");
  assert.doesNotMatch(displayed, /Export failed/);
  assert.equal(
    displayed.split("Choose a wider page").length - 1,
    1,
    "the supported remedy appears once",
  );
});
