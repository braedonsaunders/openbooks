import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { MigrationSource } from "./source.ts";
import type { NativeDocument } from "./native.ts";

const state = { stamps: 0, signOffs: 0, denied: false };
const key = Symbol.for("openbooks.source-evidence-boundaries");
(globalThis as typeof globalThis & Record<symbol, unknown>)[key] = state;
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith("/sync/source-evidence.ts")) {
      if (specifier === "../platform/db.ts")
        return { url: "mock:source-evidence-db", shortCircuit: true };
      if (specifier === "../banking/banking.ts")
        return { url: "mock:source-evidence-banking", shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === "mock:source-evidence-db")
      return {
        format: "module",
        shortCircuit: true,
        source: `
      export const db = { execute: async () => [{ source_ref: 'source-document', entry_id: 'posted-entry' }] };
    `,
      };
    if (url === "mock:source-evidence-banking")
      return {
        format: "module",
        shortCircuit: true,
        source: `
      const state = globalThis[Symbol.for('openbooks.source-evidence-boundaries')];
      export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000001';
      export async function applySourceLineEvidence(orgId, connector, entries) {
        state.stamps += entries.length;
        return { entries: entries.length, linesStamped: entries.length };
      }
      export async function refreshSourceReconciliationState() {
        return [{ accountId: 'bank-account', reconciledThrough: '2026-01-31', clearedLines: 1, unclearedLines: 0 }];
      }
      export async function signOffFromSourceEvidence() {
        state.signOffs++;
        if (state.denied) throw new Error('not found');
        return { signed: true, reconciliationId: 'reconciliation', throughDate: '2026-01-31' };
      }
    `,
      };
    return next(url, context);
  },
});
const { applySourceReconciliationEvidence } = await import("./source-evidence.ts");
const options = {
  orgId: "tenant",
  connector: "test-connector",
  refKey: "sourceId",
  source: { name: "test-connector" } as MigrationSource,
  refreshSinceForTest: "2026-01-01",
  documents: [
    {
      sourceRef: "source-document",
      lines: [{ accountId: "bank-account", sourceCleared: true, sourceClearedDate: "2026-01-31" }],
    },
  ] as NativeDocument[],
};

test("scheduled evidence preserves clearing markers and requires an operator for sign-off; operator refusals remain enforced", async () => {
  try {
    const scheduled = await applySourceReconciliationEvidence({
      ...options,
      actorId: "00000000-0000-0000-0000-000000000001",
    });
    assert.equal(state.stamps, 1);
    assert.equal(state.signOffs, 0);
    assert.equal(scheduled.linesStamped, 1);
    assert.deepEqual(scheduled.signedOff, []);
    assert.deepEqual(scheduled.skipped, [
      {
        accountId: "bank-account",
        throughDate: "2026-01-31",
        clearedLines: 1,
        unclearedLines: 0,
        reason: "operator-required",
      },
    ]);
    state.denied = true;
    await assert.rejects(
      applySourceReconciliationEvidence({ ...options, actorId: "unauthorized-operator" }),
      /not found/,
    );
    assert.equal(state.signOffs, 1);
    state.denied = false;
    const authorized = await applySourceReconciliationEvidence({
      ...options,
      actorId: "authorized-operator",
    });
    assert.equal(state.signOffs, 2);
    assert.equal(authorized.signedOff.length, 1);
    assert.deepEqual(authorized.skipped, []);
  } finally {
    hook.deregister();
    delete (globalThis as typeof globalThis & Record<symbol, unknown>)[key];
  }
});
