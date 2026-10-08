import { strict as assert } from "node:assert";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, test } from "node:test";
import pg from "pg";
import { pool, withOrgContext } from "./db.ts";
import { activeQueryObserver, registerQueryObserver } from "./query-observer.ts";

/**
 * The connection layer reports every statement it sends to the registered
 * observer with its text and database duration, never its parameter values,
 * and an observer can neither change a statement's outcome nor see anything
 * when none is registered.
 */

const ORG = "11111111-1111-4111-8111-111111111111";

type Observation = { statement: string; durationMs: number; args: number };

function fakeConnection(respond: (text: string) => Promise<unknown> = () => Promise.resolve({ rows: [], rowCount: 0 })) {
  const client = {
    query(text: string | { text: string }) {
      return respond(typeof text === "string" ? text : text.text);
    },
    release() {},
    on() { return client; },
    off() { return client; },
  };
  return client;
}

async function withConnection<T>(client: ReturnType<typeof fakeConnection>, work: () => Promise<T>): Promise<T> {
  const original = pg.Pool.prototype.connect;
  pg.Pool.prototype.connect = (async () => client) as unknown as typeof original;
  try {
    return await work();
  } finally {
    pg.Pool.prototype.connect = original;
  }
}

function recordObservations(): { observations: Observation[]; dispose: () => void } {
  const observations: Observation[] = [];
  const dispose = registerQueryObserver((...args: unknown[]) => {
    observations.push({ statement: args[0] as string, durationMs: args[1] as number, args: args.length });
  });
  return { observations, dispose };
}

let disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
});

test("each statement sent on the connection is reported with its text and duration only", async () => {
  const { observations, dispose } = recordObservations();
  disposers.push(dispose);
  await withConnection(fakeConnection(), () =>
    withOrgContext(ORG, () => pool.query("select * from invoices where id = $1", ["secret-tenant-value"])),
  );
  assert.deepEqual(
    observations.map((o) => o.statement),
    [
      "select set_config('app.current_org', $1, false), set_config('app.bypass_rls', 'off', false)",
      "select * from invoices where id = $1",
    ],
    "the tenant-scope round trip is a real round trip and is reported too",
  );
  for (const observation of observations) {
    assert.equal(observation.args, 2, "observers receive the statement and duration, never parameters");
    assert.ok(Number.isFinite(observation.durationMs) && observation.durationMs >= 0);
  }
  assert.ok(!JSON.stringify(observations).includes("secret-tenant-value"));
});

test("statements issued on one checkout are timed from when they reach the connection", async () => {
  const { observations, dispose } = recordObservations();
  disposers.push(dispose);
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
  const connection = fakeConnection(async (text) => {
    if (text === "select slow") await slow;
    return { rows: [], rowCount: 0 };
  });
  await withConnection(connection, () =>
    withOrgContext(ORG, async () => {
      const client = await pool.connect();
      try {
        const both = Promise.all([client.query("select slow"), client.query("select fast")]);
        await delay(30);
        releaseSlow();
        await both;
      } finally {
        client.release();
      }
    }),
  );
  const slowObservation = observations.find((o) => o.statement === "select slow");
  const fastObservation = observations.find((o) => o.statement === "select fast");
  assert.ok(slowObservation && fastObservation);
  assert.ok(slowObservation.durationMs >= 25, `slow statement measured ${slowObservation.durationMs}ms`);
  assert.ok(
    fastObservation.durationMs < slowObservation.durationMs,
    "time spent queued behind the slow statement is not attributed to the fast one",
  );
});

test("a failed statement is reported and still rejects with its original error", async () => {
  const { observations, dispose } = recordObservations();
  disposers.push(dispose);
  const failure = new Error("relation does not exist");
  const connection = fakeConnection((text) =>
    text === "select broken" ? Promise.reject(failure) : Promise.resolve({ rows: [], rowCount: 0 }));
  await assert.rejects(
    withConnection(connection, () => withOrgContext(ORG, () => pool.query("select broken"))),
    (error) => error === failure,
  );
  assert.ok(observations.some((o) => o.statement === "select broken"));
});

test("an observer that throws does not change the statement's result", async () => {
  disposers.push(registerQueryObserver(() => { throw new Error("observer defect"); }));
  const originalError = console.error;
  console.error = () => {};
  try {
    const rows = [{ answer: 42 }];
    const result = await withConnection(fakeConnection(() => Promise.resolve({ rows, rowCount: 1 })), () =>
      withOrgContext(ORG, () => pool.query("select 42 as answer")),
    );
    assert.deepEqual(result.rows, rows);
  } finally {
    console.error = originalError;
  }
});

test("removing an observer stops observation and never removes a later registration", async () => {
  const first = recordObservations();
  first.dispose();
  assert.equal(activeQueryObserver(), null);
  await withConnection(fakeConnection(), () => withOrgContext(ORG, () => pool.query("select 1")));
  assert.equal(first.observations.length, 0);

  const replaced = recordObservations();
  const current = recordObservations();
  disposers.push(current.dispose);
  replaced.dispose();
  await withConnection(fakeConnection(), () => withOrgContext(ORG, () => pool.query("select 2")));
  assert.equal(replaced.observations.length, 0);
  assert.ok(current.observations.some((o) => o.statement === "select 2"));
});
