import assert from "node:assert/strict";
import test from "node:test";
import { parseExactJson } from "./exact-json.ts";

test("retained financial JSON preserves original unquoted decimal and identifier tokens", () => {
  assert.deepEqual(
    parseExactJson(
      '{"amount":999999999999998.99,"id":9007199254740993,"zero":-0,"basis":0.100000,"exponent":1e3}',
      { rejectDuplicateKeys: true },
    ),
    {
      amount: "999999999999998.99",
      id: "9007199254740993",
      zero: "-0",
      basis: "0.100000",
      exponent: "1e3",
    },
  );
});

test("strict retained evidence refuses duplicate decoded keys at every object depth", () => {
  for (const text of [
    '{"amount":1,"amount":2}',
    '{"amount":1,"\\u0061mount":2}',
    '{"source":[{"currency":"CAD","currency":"USD"}]}',
    '{"__proto__":null,"__proto__":{"private":true}}',
  ])
    assert.throws(
      () => parseExactJson(text, { rejectDuplicateKeys: true }),
      /duplicate object key/,
    );
  assert.deepEqual(parseExactJson('{"amount":1,"amount":2}'), { amount: "2" });
});

test("the strict parser keeps structural types, escapes and safe own properties", () => {
  const parsed = parseExactJson(
    '{"text":"line\\nbreak","yes":true,"no":false,"empty":null,"items":[],"__proto__":{"own":true}}',
    { rejectDuplicateKeys: true },
  ) as Record<string, unknown>;
  assert.equal(parsed.text, "line\nbreak");
  assert.equal(parsed.yes, true);
  assert.equal(parsed.no, false);
  assert.equal(parsed.empty, null);
  assert.deepEqual(parsed.items, []);
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(parsed, "__proto__"), true);
  assert.deepEqual(parsed.__proto__, { own: true });
});

test("strict evidence refuses invalid number tokens, trailing facts and excessive nesting", () => {
  for (const text of ['{"amount":01}', '{"amount":1.}', '{"amount":1e}', "{}{}", "[1,]"]) {
    assert.throws(() => parseExactJson(text, { rejectDuplicateKeys: true }), SyntaxError);
  }
  assert.throws(
    () => parseExactJson("[".repeat(201) + "0" + "]".repeat(201), { rejectDuplicateKeys: true }),
    /nesting deeper/,
  );
});
