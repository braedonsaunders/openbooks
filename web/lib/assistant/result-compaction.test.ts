import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  byteSize,
  compactToolResultForModel,
  createTurnCompactor,
  MODEL_RESULT_ARRAY_ITEMS,
  MODEL_RESULT_BYTES,
  MODEL_TURN_BYTES,
  withModelCompaction,
} from "./result-compaction";

const row = (i: number) => ({
  id: `row-${i}`,
  account: "1000",
  name: `Cash account line ${i}`,
  memo: `memo-${i}`,
  amount: "1234.56",
});

test("long strings are truncated with an explicit marker", () => {
  const compacted = compactToolResultForModel({ ok: true, data: { memo: "x".repeat(5000) } }) as {
    data: { memo: string };
  };
  assert.ok(compacted.data.memo.length < 5000);
  assert.match(compacted.data.memo, /\[truncated \d+ chars\]/);
});

test("oversized arrays are capped and carry truncatedCount", () => {
  const compacted = compactToolResultForModel({ ok: true, data: { rows: Array.from({ length: 500 }, (_, i) => row(i)) } }) as {
    data: { rows: { items: unknown[]; truncatedCount: number } };
  };
  assert.ok(Array.isArray(compacted.data.rows.items));
  assert.ok(compacted.data.rows.items.length <= MODEL_RESULT_ARRAY_ITEMS);
  assert.equal(
    compacted.data.rows.items.length + compacted.data.rows.truncatedCount,
    500,
  );
});

test("objects nested deeper than the limit are flattened to shape markers", () => {
  let deep: unknown = { leaf: "value" };
  for (let i = 0; i < 12; i++) deep = { level: i, child: deep };
  const compacted = compactToolResultForModel({ ok: true, data: deep });
  assert.ok(byteSize(compacted) < byteSize({ ok: true, data: deep }));
  assert.match(JSON.stringify(compacted), /truncated for model context/);
});

test("a 500-row tool result compacts to within the per-result budget", () => {
  const big = {
    ok: true,
    data: {
      total: 500,
      rows: Array.from({ length: 500 }, (_, i) => ({
        ...row(i),
        description: `detailed description for row ${i} `.repeat(20),
      })),
    },
  };
  assert.ok(byteSize(big) > MODEL_RESULT_BYTES);
  const compacted = compactToolResultForModel(big);
  assert.ok(
    byteSize(compacted) <= MODEL_RESULT_BYTES,
    `compacted ${byteSize(compacted)} bytes exceeds budget ${MODEL_RESULT_BYTES}`,
  );
});

test("small results pass through untouched", () => {
  const small = { ok: true, data: { total: 2, rows: [row(1), row(2)] } };
  assert.deepEqual(compactToolResultForModel(small), small);
});

test("twelve worst-case steps cannot exceed the per-turn budget", () => {
  const compact = createTurnCompactor();
  let total = 0;
  for (let step = 0; step < 12; step++) {
    const big = { ok: true, data: { rows: Array.from({ length: 500 }, (_, i) => row(i)) } };
    const compacted = compact({ ...big, step });
    total += byteSize(compacted);
    assert.ok(byteSize(compacted) <= MODEL_RESULT_BYTES);
  }
  assert.ok(
    total <= MODEL_TURN_BYTES,
    `turn total ${total} bytes exceeds budget ${MODEL_TURN_BYTES}`,
  );
});

test("withModelCompaction keeps execute and adds a compacting toModelOutput", async () => {
  const execute = async () => ({ ok: true as const, data: { rows: Array.from({ length: 500 }, (_, i) => row(i)) } });
  const tools = { big_tool: { description: "d", inputSchema: {}, execute } } as never;
  const wrapped = withModelCompaction(tools) as unknown as Record<string, {
    execute: typeof execute;
    toModelOutput: (args: { output: unknown }) => { type: string; value: unknown };
  }>;
  const entry = wrapped.big_tool;
  assert.ok(entry);
  assert.equal(entry.execute, execute);
  const full = await execute();
  assert.ok(byteSize(full) > MODEL_RESULT_BYTES);
  const modelOutput = entry.toModelOutput({ output: full });
  assert.equal(modelOutput.type, "json");
  assert.ok(byteSize(modelOutput.value) <= MODEL_RESULT_BYTES);
  // Idempotent: wrapping twice returns the same set.
  assert.equal(withModelCompaction(wrapped as unknown as never), wrapped);
});

test("the agent turn and the chat route compact model-facing tool output", () => {
  const agent = readFileSync(new URL("./agent.ts", import.meta.url), "utf8");
  assert.match(agent, /withModelCompaction\(/);
  assert.match(agent, /from "\.\/result-compaction"/);
  const route = readFileSync(new URL("../../app/api/assistant/chat/route.ts", import.meta.url), "utf8");
  assert.match(route, /withModelCompaction\(/);
});
