import assert from "node:assert/strict";
import test from "node:test";
import { newAsyncContext } from "./quickjs.ts";

/**
 * Regression: contexts created by newAsyncContext() used to share ONE
 * asyncify WebAssembly module. Two concurrently executing scripts corrupted
 * the shared machine's asyncify unwind state and aborted the whole Node
 * process ("Assertion failed: list_empty(&rt->gc_obj_list)" in
 * JS_FreeRuntime). Production hits this whenever before_post trigger scripts
 * run during parallel document postings, or when scheduled/bulk/endpoint
 * scripts overlap on the worker.
 *
 * Each run below mirrors engine/src/scripting.ts's usage shape: a fresh
 * context, an asyncified host function that REALLY suspends the WASM (like
 * ob.query awaiting SQL), and a script that suspends repeatedly while CPU
 * work happens between suspensions.
 */
async function runScriptLikeProduction(i: number): Promise<string> {
  const vm = await newAsyncContext();
  try {
    const sleep = vm.newAsyncifiedFunction("__sleep", async (msH) => {
      await new Promise((resolve) => setTimeout(resolve, Number(vm.dump(msH))));
    });
    vm.setProp(vm.global, "__sleep", sleep);
    sleep.dispose();

    const result = await vm.evalCodeAsync(`
      function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
      var t = 0;
      for (var k = 0; k < 4; k++) { __sleep(5); t += fib(14); }
      JSON.stringify({ n: ${i}, t });
    `);
    if (result.error) {
      const err = vm.dump(result.error);
      result.error.dispose();
      throw new Error(
        `sandboxed script ${i} failed: ${
          typeof err === "object" && err && "message" in err
            ? String(err.message)
            : String(err)
        }`,
      );
    }
    const raw = vm.dump(result.value);
    result.value.dispose();
    return raw;
  } finally {
    // Same disposal order as production callers.
    vm.dispose();
    vm.runtime.dispose();
  }
}

test("concurrent async sandboxed scripts do not corrupt the WASM machine", async () => {
  const concurrency = 8;
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => runScriptLikeProduction(i)),
  );
  assert.equal(results.length, concurrency);
  // Every script returns its own correct result — cross-context corruption
  // would surface as an abort, a thrown error, or wrong values.
  results.forEach((raw, i) => {
    assert.deepEqual(JSON.parse(raw), { n: i, t: 377 * 4 });
  });
});

test("repeated sequential sandbox creation stays healthy after concurrent use", async () => {
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(JSON.parse(await runScriptLikeProduction(100 + i)), {
      n: 100 + i,
      t: 377 * 4,
    });
  }
});
