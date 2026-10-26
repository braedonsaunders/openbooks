import assert from "node:assert/strict";
import test from "node:test";
import { partyEmailInvalid } from "./party-email.ts";

test("a party email is blank or one deliverable mailbox", () => {
  for (const value of [
    null,
    undefined,
    "",
    "   ",
    "qa.beta@example.com",
    " founder@northstar.example ",
  ])
    assert.equal(partyEmailInvalid(value), false, String(value));
  for (const value of [
    "not-an-email",
    "qa beta@example.com",
    "a@@example.com",
    "@example.com",
    "name@",
    42,
  ])
    assert.equal(partyEmailInvalid(value), true, String(value));
});
