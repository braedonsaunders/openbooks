import assert from "node:assert/strict";
import test from "node:test";
import ssh2 from "ssh2";

const { validateAuthorizedKeys } = await import("./authorized-keys.ts");

function realKeyLine(comment = "op@openbooks.test"): string {
  const { public: pub } = ssh2.utils.generateKeyPairSync("ed25519");
  return `${pub.trim()}${comment ? ` ${comment}` : ""}`;
}

test("a real generated key validates and normalizes to canonical spacing", () => {
  const line = realKeyLine();
  const [type, blob, ...rest] = line.split(" ");
  const padded = `  ${type}   ${blob}    ${rest.join(" ")}  `;
  assert.deepEqual(validateAuthorizedKeys(`\n# bank deploy key\n${padded}\n`), [line]);
});

test("malformed lines are refused with physical line numbers", () => {
  const good = realKeyLine();
  assert.throws(
    () => validateAuthorizedKeys([good, "hello world", "", "# comment", "ssh-ed25519 not-base64!!!"].join("\n")),
    /line 2: .*Unsupported key format.*line 5: .*Unsupported key format/,
  );
});

test("a pasted private-key block is refused, naming its first bad line", () => {
  const { private: priv } = ssh2.utils.generateKeyPairSync("ed25519");
  assert.throws(() => validateAuthorizedKeys(String(priv)), /line 1: /);
});

test("an input with no key lines validates to an empty set for the caller to judge", () => {
  assert.deepEqual(validateAuthorizedKeys("\n  \n# only a comment\n"), []);
});
