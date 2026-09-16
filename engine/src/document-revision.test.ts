import assert from "node:assert/strict";
import test from "node:test";
import { DOCUMENT_REVISION_PATTERN, isDocumentRevisionToken } from "./document-revision.ts";

test("revision tokens accept counters and legacy timestamps, nothing else", () => {
  // Canonical counter tokens from migration 0167.
  assert.equal(isDocumentRevisionToken("0"), true);
  assert.equal(isDocumentRevisionToken("41"), true);
  // Legacy six-digit timestamp tokens from tables whose updated_at still
  // doubles as the token keep validating so those writers keep working.
  assert.equal(isDocumentRevisionToken("2026-08-24T12:00:00.123001Z"), true);
  // Anything else fails closed: lossy dates, truncated fractions, blanks.
  for (const bad of [
    "",
    "garbage",
    "2026-08-24T12:00:00.123Z",
    "2026-08-24 12:00:00.123001+00",
    "2026-08-24T12:00:00Z",
    "-1",
    "12.5",
    " 41",
    "41 ",
    null,
    undefined,
    41,
  ]) {
    assert.equal(isDocumentRevisionToken(bad), false, JSON.stringify(bad));
  }
  assert.match("41", new RegExp(DOCUMENT_REVISION_PATTERN));
});
