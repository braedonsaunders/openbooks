import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Bench bank v2 shape contract: same {id, tier, title, prompt|turns, expect}
// shape as tmp/assistant-bench/bank.json, vendor-neutral throughout.

const joined = (...parts: string[]) => parts.join("");

// Fragment-built so this file never carries a vendor literal itself.
const vendorPatterns = [
  new RegExp(joined("Net", "Suite"), "i"),
  new RegExp(joined("Quick", "Books"), "i"),
  new RegExp(joined("Xe", "ro"), "i"),
  new RegExp(joined("Od", "oo"), "i"),
  new RegExp(joined("Sage ", "Intacct"), "i"),
  new RegExp(joined("Suite", "QL"), "i"),
  new RegExp(joined("One", "World"), "i"),
];

type BankEntry = {
  id: string;
  tier: number;
  title: string;
  prompt?: string;
  turns?: string[];
  expect: string;
};

const bank = JSON.parse(readFileSync(new URL("./bank.json", import.meta.url), "utf8")) as BankEntry[];

test("bank v2 holds 20+ graded questions in the bank shape", () => {
  assert.ok(Array.isArray(bank));
  assert.ok(bank.length >= 20, `expected 20+ questions, found ${bank.length}`);
  const ids = new Set<string>();
  for (const entry of bank) {
    assert.match(entry.id, /^v2-[a-z0-9-]+$/);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok([1, 2, 3, 4].includes(entry.tier), `${entry.id}: tier must be 1-4`);
    assert.ok(entry.title.trim().length > 0, `${entry.id}: title required`);
    const hasPrompt = typeof entry.prompt === "string" && entry.prompt.trim().length > 0;
    const hasTurns =
      Array.isArray(entry.turns) &&
      entry.turns.length >= 2 &&
      entry.turns.every((turn) => typeof turn === "string" && turn.trim().length > 0);
    assert.ok(hasPrompt !== hasTurns, `${entry.id}: exactly one of prompt / turns`);
    assert.ok(typeof entry.expect === "string" && entry.expect.trim().length > 0, `${entry.id}: expect required`);
  }
});

test("bank v2 stays vendor-neutral", () => {
  for (const entry of bank) {
    const text = [entry.title, entry.prompt ?? "", ...(entry.turns ?? []), entry.expect].join("\n");
    for (const pattern of vendorPatterns) {
      assert.doesNotMatch(text, pattern, `${entry.id} names a vendor system`);
    }
  }
});

test("bank v2 covers writes, app tools, and every a03-a05 domain", () => {
  const text = bank.map((entry) => `${entry.id} ${entry.prompt ?? ""} ${(entry.turns ?? []).join(" ")} ${entry.expect}`.toLowerCase()).join("\n");
  for (const marker of [
    "confirmation card", // settings/features/setup writes never claim the write
    "describe_capabilities",
    "update_features",
    "setup", // setup-record reads/writes
    "app", // app-declared tools
    "inventory", // a03
    "orders",
    "asset",
    "equipment",
    "wip",
    "crm", // a04
    "subscription",
    "property",
    "time",
    "expense",
    "close", // a05
    "journal",
    "reconcil", // banking actions
    "reval", // FX revaluation
    "budget",
    "audit", // admin reads
  ]) {
    assert.ok(text.includes(marker), `bank v2 never exercises ${marker}`);
  }
});
