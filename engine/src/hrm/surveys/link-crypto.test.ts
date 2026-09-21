import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { decryptRespondentLink, encryptRespondentLink } from "./responses.ts";

const priorSecret = process.env.SESSION_SECRET;

before(() => {
  process.env.SESSION_SECRET = "openbooks-test-only-hrm-secret";
});

after(() => {
  if (priorSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = priorSecret;
});

const ORG = "00000000-0000-7000-8000-000000000001";
const PARTY = "00000000-0000-7000-8000-000000000002";

test("confidential links round-trip and never contain the party in clear", () => {
  const sealed = encryptRespondentLink(ORG, PARTY);
  assert.ok(!Buffer.from(sealed).toString("utf8").includes(PARTY));
  assert.equal(decryptRespondentLink(ORG, sealed), PARTY);
});

test("confidential links are org-bound: another org cannot open them", () => {
  const sealed = encryptRespondentLink(ORG, PARTY);
  assert.throws(
    () => decryptRespondentLink("00000000-0000-7000-8000-000000000003", sealed),
    /unable to authenticate|unsupported/i,
  );
});

test("tampered confidential links fail closed", () => {
  const sealed = Buffer.from(encryptRespondentLink(ORG, PARTY));
  sealed[sealed.length - 1]! ^= 0xff;
  assert.throws(() => decryptRespondentLink(ORG, sealed));
});
