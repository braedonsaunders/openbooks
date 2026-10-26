import assert from "node:assert/strict";
import test from "node:test";
import { memoizedRead, withReadMemo } from "./read-memo.ts";

test("inside a render a read loads once and every caller shares its answer", async () => {
  let loads = 0;
  const load = async () => {
    loads += 1;
    return { loads };
  };
  const [first, second, third] = await withReadMemo(() =>
    Promise.all([
      memoizedRead("book:a", load),
      memoizedRead("book:a", load),
      memoizedRead("book:b", load),
    ]),
  );
  assert.equal(first, second, "the same key shares one answer, even when asked concurrently");
  assert.notEqual(first, third, "another key loads on its own");
  assert.equal(loads, 2);
});

test("outside a render, and in another render, every read loads fresh", async () => {
  let loads = 0;
  const load = async () => ++loads;
  assert.equal(await memoizedRead("book:a", load), 1);
  assert.equal(await memoizedRead("book:a", load), 2, "no memo outside a scope");
  await withReadMemo(() => memoizedRead("book:a", load));
  await withReadMemo(() => memoizedRead("book:a", load));
  assert.equal(loads, 4, "one render's memo never answers another");
});

test("a failed read is not remembered: a retry in the same render loads again", async () => {
  let attempts = 0;
  await withReadMemo(async () => {
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("connection reset");
      return "book";
    };
    await assert.rejects(memoizedRead("book:a", flaky), /connection reset/);
    assert.equal(await memoizedRead("book:a", flaky), "book");
  });
  assert.equal(attempts, 2);
});
