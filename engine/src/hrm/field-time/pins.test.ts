import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { hashDeviceToken, hashPin, issueDeviceToken, verifyPin } from "./pins.ts";

describe("clock PINs", () => {
  it("a correct PIN verifies and a wrong one does not", () => {
    const stored = hashPin("4821");
    assert.equal(verifyPin("4821", stored), true);
    assert.equal(verifyPin("4822", stored), false);
  });
  it("non-numeric PINs are refused by name", () => {
    assert.throws(() => hashPin("abcd"), /4 to 10 digits/);
    assert.throws(() => hashPin("123"), /4 to 10 digits/);
  });
  it("device tokens hash stably and never reveal the raw token", () => {
    const { token, tokenHash } = issueDeviceToken();
    assert.equal(hashDeviceToken(token), tokenHash);
    assert.ok(!tokenHash.includes(token.slice(0, 8)));
  });
});
