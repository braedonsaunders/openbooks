import assert from "node:assert/strict";
import test from "node:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { db } from "../platform/db.ts";
import {
  claimPostingEffectsForDocument,
  markPostingEffectsFailed,
  markPostingEffectsSucceeded,
  MAX_POSTING_EFFECTS_ATTEMPTS,
  postingEffectsBackoffMs,
  PostingEffectsLeaseFencedError,
  replayTerminalPostingEffect,
  type PostingEffectsRow,
} from "./posting-effects.ts";

// Unit-partition behavior cover for the posting-effects outbox. Every
// database touch below is a scripted double returning realistic rows and
// affected-row counts; the doubles refuse (rowCount 0, exists false, empty
// rows) wherever the real boundary must refuse.

type StubRows = { rows: Record<string, unknown>[]; rowCount: number };
type TxStub = { execute: (query: unknown) => Promise<StubRows> };

async function withStubbedDb<T>(
  options: {
    execute?: (query: unknown) => Promise<StubRows>;
    transaction?: (fn: (tx: TxStub) => Promise<unknown>) => Promise<unknown>;
  },
  fn: () => Promise<T>,
): Promise<T> {
  const target = db as unknown as Record<string, unknown>;
  const executeDescriptor = Object.getOwnPropertyDescriptor(target, "execute");
  const transactionDescriptor = Object.getOwnPropertyDescriptor(target, "transaction");
  if (options.execute !== undefined) target.execute = options.execute;
  if (options.transaction !== undefined) target.transaction = options.transaction;
  try {
    return await fn();
  } finally {
    if (options.execute !== undefined) {
      if (executeDescriptor) Object.defineProperty(target, "execute", executeDescriptor);
      else delete target.execute;
    }
    if (options.transaction !== undefined) {
      if (transactionDescriptor) Object.defineProperty(target, "transaction", transactionDescriptor);
      else delete target.transaction;
    }
  }
}

// Compile with the real dialect: inspect exactly the parameters PostgreSQL
// receives, without reimplementing Drizzle's chunk traversal.
function boundParams(query: unknown): unknown[] {
  return new PgDialect().sqlToQuery(query as SQL).params;
}

const claim: PostingEffectsRow = {
  id: "11111111-1111-4111-8111-111111111111",
  org_id: "22222222-2222-4222-8222-222222222222",
  document_id: "33333333-3333-4333-8333-333333333333",
  kind: "invoice",
  entry_id: "44444444-4444-4444-8444-444444444444",
  posting_date: "2026-01-01",
  actor_id: null,
  attempt_count: 1,
  lease_token: "55555555-5555-4555-8555-555555555555",
};

const NOW = new Date("2026-02-01T00:00:00.000Z");

test("backoff holds the one-minute floor on the first retry and caps at one hour", () => {
  assert.equal(postingEffectsBackoffMs(0), 60_000);
  assert.equal(postingEffectsBackoffMs(1), 60_000);
  assert.equal(postingEffectsBackoffMs(6), 1_920_000);
  assert.equal(postingEffectsBackoffMs(7), 3_600_000);
  assert.equal(postingEffectsBackoffMs(MAX_POSTING_EFFECTS_ATTEMPTS), 3_600_000);
  assert.equal(postingEffectsBackoffMs(MAX_POSTING_EFFECTS_ATTEMPTS + 10), 3_600_000);
});

test("a completion whose lease is gone is fenced by claim id", async () => {
  await withStubbedDb({ execute: async () => ({ rows: [], rowCount: 1 }) }, async () => {
    await markPostingEffectsSucceeded(claim, NOW);
  });
  await withStubbedDb({ execute: async () => ({ rows: [], rowCount: 0 }) }, async () => {
    await assert.rejects(
      () => markPostingEffectsSucceeded(claim, NOW),
      (error: unknown) => {
        assert.ok(error instanceof PostingEffectsLeaseFencedError);
        assert.match(error.message, new RegExp(claim.id));
        return true;
      },
    );
  });
});

test("failure evidence keeps the first 1000 characters of the message", async () => {
  const captured: unknown[] = [];
  const tx: TxStub = {
    execute: async (query: unknown) => {
      captured.push(query);
      return { rows: [{ becameTerminal: false }], rowCount: 1 };
    },
  };
  await withStubbedDb({ transaction: async (fn) => fn(tx) }, async () => {
    await markPostingEffectsFailed(
      { ...claim, attempt_count: 1 },
      new Error("x".repeat(2500)),
      NOW,
    );
  });
  const evidence = captured.flatMap(boundParams).filter((p): p is string => typeof p === "string");
  assert.ok(evidence.some((s) => s === "x".repeat(1000)), "truncated message is bound as evidence");
  assert.ok(
    !evidence.some((s) => s.length > 1000 && s.includes("x".repeat(64))),
    "no bound evidence carries the overflow",
  );
});

test("a retry stays retryable below the ceiling and turns terminal at it", async () => {
  const runFailed = async (attemptCount: number): Promise<unknown[]> => {
    const captured: unknown[] = [];
    const tx: TxStub = {
      execute: async (query: unknown) => {
        captured.push(query);
        return { rows: [{ becameTerminal: false }], rowCount: 1 };
      },
    };
    await withStubbedDb({ transaction: async (fn) => fn(tx) }, async () => {
      await markPostingEffectsFailed({ ...claim, attempt_count: attemptCount }, new Error("boom"), NOW);
    });
    return captured.flatMap(boundParams);
  };
  const below = await runFailed(MAX_POSTING_EFFECTS_ATTEMPTS - 1);
  assert.ok(!below.includes(true), "below the ceiling nothing binds the terminal branch");
  const at = await runFailed(MAX_POSTING_EFFECTS_ATTEMPTS);
  assert.ok(at.includes(true), "at the ceiling the terminal branch is bound");
});

test("a document claim reports terminal poison distinctly from retryable work", async () => {
  const runClaim = async (scripted: StubRows[]): Promise<unknown> => {
    let call = 0;
    return withStubbedDb(
      { execute: async () => (scripted[call++] ?? (() => { throw new Error("unexpected database query"); })()) },
      async () => claimPostingEffectsForDocument("33333333-3333-4333-8333-333333333333", NOW),
    );
  };
  const claimed = await runClaim([{ rows: [{ ...claim }], rowCount: 1 }]);
  assert.equal((claimed as PostingEffectsRow).id, claim.id);
  assert.equal(await runClaim([{ rows: [], rowCount: 0 }, { rows: [{ status: "succeeded" }], rowCount: 1 }]), "succeeded");
  assert.equal(await runClaim([{ rows: [], rowCount: 0 }, { rows: [{ status: "failed" }], rowCount: 1 }]), "running");
  assert.equal(
    await runClaim([{ rows: [], rowCount: 0 }, { rows: [{ status: "terminal_failed" }], rowCount: 1 }]),
    "terminal_failed",
  );
  assert.equal(await runClaim([{ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }]), null);
});

test("a short replay reason is refused before any database work", async () => {
  let hits = 0;
  const refuse = async (): Promise<StubRows> => {
    hits += 1;
    throw new Error("database must not be touched");
  };
  const base = {
    orgId: "22222222-2222-4222-8222-222222222222",
    id: "11111111-1111-4111-8111-111111111111",
    actorId: "66666666-6666-4666-8666-666666666666",
  };
  await withStubbedDb({ execute: refuse, transaction: refuse }, async () => {
    await assert.rejects(() => replayTerminalPostingEffect({ ...base, reason: "too short" }), /between 10 and 1000/);
    await assert.rejects(
      () => replayTerminalPostingEffect({ ...base, reason: "x".repeat(1001) }),
      /between 10 and 1000/,
    );
  });
  assert.equal(hits, 0);
  // A 1000-character reason clears the fence and reaches the database.
  await withStubbedDb(
    {
      transaction: async () => {
        throw new Error("db-stub-reached");
      },
    },
    async () => {
      await assert.rejects(
        () => replayTerminalPostingEffect({ ...base, reason: "r".repeat(1000), now: NOW }),
        /db-stub-reached/,
      );
    },
  );
});

test("replay names an inactive actor and a non-terminal row", async () => {
  const reason = "operator investigated the poison payload and authorized one more attempt";
  const base = {
    orgId: "22222222-2222-4222-8222-222222222222",
    id: "11111111-1111-4111-8111-111111111111",
    actorId: "66666666-6666-4666-8666-666666666666",
    reason,
    now: NOW,
  };
  const txDenied: TxStub = {
    execute: async () => ({ rows: [{ exists: false }], rowCount: 1 }),
  };
  await withStubbedDb({ transaction: async (fn) => fn(txDenied) }, async () => {
    await assert.rejects(() => replayTerminalPostingEffect(base), /not an active user/);
  });
  // Zero actor rows (the unscoped shape) is the same refusal, not a success.
  const txMissing: TxStub = { execute: async () => ({ rows: [], rowCount: 0 }) };
  await withStubbedDb({ transaction: async (fn) => fn(txMissing) }, async () => {
    await assert.rejects(() => replayTerminalPostingEffect(base), /not an active user/);
  });
  const scripted: StubRows[] = [
    { rows: [{ exists: true }], rowCount: 1 },
    {
      rows: [
        {
          status: "failed",
          attempt_count: MAX_POSTING_EFFECTS_ATTEMPTS,
          terminal_failure_reason: "boom",
          terminal_failed_at: NOW,
          terminal_failed_by: "posting-effects-worker",
          document_id: "33333333-3333-4333-8333-333333333333",
          kind: "invoice",
        },
      ],
      rowCount: 1,
    },
  ];
  let call = 0;
  const txState: TxStub = { execute: async () => (scripted[call++] ?? (() => { throw new Error("unexpected database query"); })()) };
  await withStubbedDb({ transaction: async (fn) => fn(txState) }, async () => {
    await assert.rejects(() => replayTerminalPostingEffect(base), /only terminal-failed/);
  });
});
