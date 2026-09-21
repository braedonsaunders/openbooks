import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  hashHrmToken,
  mintDocumentSignerToken,
  mintSurveyInvitationToken,
  verifyDocumentSignerToken,
  verifySurveyInvitationToken,
} from "./tokens.ts";

// The product reads the secret live from process.env, so seed it there too.
const priorSecret = process.env.SESSION_SECRET;

before(() => {
  process.env.SESSION_SECRET = "openbooks-test-only-hrm-secret";
});

after(() => {
  if (priorSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = priorSecret;
});

const ORG = "00000000-0000-7000-8000-000000000001";
const ROW = "00000000-0000-7000-8000-000000000002";

test("document signer token verifies and binds its row", () => {
  const token = mintDocumentSignerToken(ORG, ROW, new Date(Date.now() + 3_600_000));
  const claims = verifyDocumentSignerToken(token);
  assert.ok(claims);
  assert.equal(claims.orgId, ORG);
  assert.equal(claims.rowId, ROW);
});

test("expired document token is refused", () => {
  const token = mintDocumentSignerToken(ORG, ROW, new Date(Date.now() - 1_000));
  assert.equal(verifyDocumentSignerToken(token), null);
});

test("tampered document token is refused", () => {
  const token = mintDocumentSignerToken(ORG, ROW, new Date(Date.now() + 3_600_000));
  const [body] = token.split(".");
  assert.equal(verifyDocumentSignerToken(`${body}.deadbeef`), null);
  assert.equal(verifyDocumentSignerToken("not-a-token"), null);
});

test("document and survey tokens do not cross-verify (domain separation)", () => {
  const doc = mintDocumentSignerToken(ORG, ROW, new Date(Date.now() + 3_600_000));
  const inv = mintSurveyInvitationToken(ORG, ROW, new Date(Date.now() + 3_600_000));
  assert.equal(verifySurveyInvitationToken(doc), null);
  assert.equal(verifyDocumentSignerToken(inv), null);
  assert.ok(verifySurveyInvitationToken(inv));
});

test("token hashes are stable digests that never contain the token", () => {
  const token = mintDocumentSignerToken(ORG, ROW, new Date(Date.now() + 3_600_000));
  const digest = hashHrmToken(token);
  assert.equal(digest, hashHrmToken(token));
  assert.equal(digest.length, 64);
  assert.ok(!digest.includes(token.slice(0, 12)));
});
