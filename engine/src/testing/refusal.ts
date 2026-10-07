import assert from "node:assert/strict";

/**
 * Await a refusal of the expected class and, when given, message; return
 * the error so the caller can assert its code or structural fields.
 */
export async function refusal<E extends abstract new (...args: never[]) => Error>(
  promise: Promise<unknown>,
  expected: E,
  message?: RegExp | string,
): Promise<InstanceType<E>> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof expected, `expected ${expected.name}, got ${String(error)}`);
    if (typeof message === "string") assert.equal(error.message, message);
    else if (message) assert.match(error.message, message);
    return error as InstanceType<E>;
  }
  throw new Error(`expected a ${expected.name} refusal, the call succeeded`);
}

