import assert from "node:assert/strict";
import test from "node:test";
import {
  PROVISIONAL_TITLE_CHARS,
  provisionalTitle,
  reconcileConversations,
  removeConversationRow,
  renameConversationRow,
  upsertProvisionalConversation,
  type SidebarConversation,
} from "./sidebar-state";

function row(id: string, title = `title-${id}`): SidebarConversation {
  return { id, title, updatedAt: "2026-09-16T00:00:00.000Z" };
}

test("provisional title matches the server's 60-char prompt slice", () => {
  assert.equal(PROVISIONAL_TITLE_CHARS, 60);
  assert.equal(provisionalTitle("  hello  "), "hello");
  assert.equal(provisionalTitle("x".repeat(200)).length, 60);
});

test("a new thread id is inserted at the top immediately", () => {
  const next = upsertProvisionalConversation([row("old-1"), row("old-2")], row("new-9", "hello"));
  assert.deepEqual(next.map((c) => c.id), ["new-9", "old-1", "old-2"]);
});

test("insert never clobbers an existing row (a rename in flight wins)", () => {
  const next = upsertProvisionalConversation(
    [row("new-9", "My renamed title")],
    row("new-9", "raw prompt slice"),
  );
  assert.equal(next[0]!.title, "My renamed title");
});

test("end-of-turn reconcile keeps a provisional row the server omits", () => {
  const local = [row("new-9", "hello"), row("old-1")];
  const { items, provisionalIds } = reconcileConversations(local, [row("old-1")], new Set(["new-9"]));
  assert.deepEqual(items.map((c) => c.id), ["new-9", "old-1"]);
  assert.ok(provisionalIds.has("new-9"));
});

test("reconcile drops the provisional pin once the server knows the id", () => {
  const local = [row("new-9", "hello"), row("old-1")];
  const { items, provisionalIds } = reconcileConversations(
    local,
    [row("new-9", "hello"), row("old-1")],
    new Set(["new-9"]),
  );
  assert.deepEqual(items.map((c) => c.id), ["new-9", "old-1"]);
  assert.equal(provisionalIds.size, 0);
});

test("a rename during streaming survives the end-of-turn reconcile", () => {
  // Turn starts (provisional insert), the user renames mid-stream, then the
  // stream ends and the server list arrives without the new thread yet.
  let list = upsertProvisionalConversation([row("old-1")], row("new-9", "raw prompt slice"));
  list = renameConversationRow(list, "new-9", "My renamed title");
  const { items } = reconcileConversations(list, [row("old-1")], new Set(["new-9"]));
  assert.equal(items[0]!.id, "new-9");
  assert.equal(items[0]!.title, "My renamed title");
});

test("a delete during streaming stays deleted after reconcile", () => {
  // The user deletes an older thread mid-stream; the fresh server list no
  // longer carries it. The provisional streaming row survives regardless.
  const local = removeConversationRow([row("new-9", "hello"), row("old-1")], "old-1");
  const { items } = reconcileConversations(local, [row("older-0")], new Set(["new-9"]));
  assert.deepEqual(items.map((c) => c.id), ["new-9", "older-0"]);
});

test("deleting the streaming thread itself drops its provisional pin", () => {
  // doDelete removes the id from the provisional set as well as the list, so
  // the end-of-turn reconcile cannot resurrect the deleted thread.
  const local = removeConversationRow([row("new-9", "hello"), row("old-1")], "new-9");
  const { items, provisionalIds } = reconcileConversations(local, [row("old-1")], new Set());
  assert.deepEqual(items.map((c) => c.id), ["old-1"]);
  assert.equal(provisionalIds.size, 0);
});
