import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import "../../dashboard/_dashboard-render-harness";
import { act, click, mountDashboard, scriptFetch } from "../../dashboard/_dashboard-render-harness";

// Await-imports (not static imports): module hooks register while the
// harness above evaluates, so only imports that resolve after that point see
// the jsdom shims. The harness mocks '@/lib/confirm' with an auto-answer
// (no ConfirmRoot UI ships under the mock), so confirmation is driven
// through globalThis.__confirmAnswer: false proves the gate, true proceeds.
const { StatementDeleteCell } = await import("./StatementDeleteCell");

// The dashboard harness models confirmation headlessly: confirmDialog
// resolves globalThis.__confirmAnswer without rendering a dialog, so these
// tests pin the confirm gate by answering false (nothing sends) then true.
function confirmAnswer(value: boolean): void {
  (globalThis as unknown as { __confirmAnswer: boolean }).__confirmAnswer = value;
}

const dir = dirname(fileURLToPath(import.meta.url));
const messages = {
  banking: JSON.parse(
    readFileSync(join(dir, "..", "..", "..", "..", "messages", "en", "banking.json"), "utf8"),
  ),
  common: JSON.parse(
    readFileSync(join(dir, "..", "..", "..", "..", "messages", "en", "common.json"), "utf8"),
  ),
  ui: JSON.parse(
    readFileSync(join(dir, "..", "..", "..", "..", "messages", "en", "ui.json"), "utf8"),
  ),
};

const STATEMENT_ID = "11111111-0000-4000-8000-000000000001";

// Import History offers delete per import: a blocked import names its reason
// on the disabled control, and deleting confirms first, then toasts the
// engine's result and refreshes the history.

function deleteButton(): HTMLButtonElement | null {
  return document.querySelector('button[aria-label="Delete import"]');
}

function toasts(): { kind: string; message: string }[] {
  return (globalThis as unknown as { __dashToasts: { kind: string; message: string }[] })
    .__dashToasts;
}

test("a blocked import names its reason on the disabled control", async () => {
  const { unmount } = await mountDashboard(
    <StatementDeleteCell
      statementId={STATEMENT_ID}
      lineCount={2}
      blockedReason="Has 1 matched line — unmatch it first"
      confirmMessage="Delete?"
      showDelete
    />,
    messages,
  );
  try {
    const button = deleteButton();
    assert.ok(button, "the blocked import still shows its delete control");
    assert.equal(button.disabled, true, "the blocked delete cannot run");
    assert.equal(
      button.title,
      "Has 1 matched line — unmatch it first",
      "the reason names the remedy",
    );
  } finally {
    await unmount();
  }
});

test("deleting confirms first, then toasts and refreshes", async () => {
  const calls: { url: string; method?: string }[] = [];
  let refreshed = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.includes(`/api/banking/statements/${STATEMENT_ID}`)) {
      calls.push({ url, method: init?.method });
      return Response.json({ ok: true, deletedLines: 3 });
    }
    return null;
  });
  const { unmount } = await mountDashboard(
    <StatementDeleteCell
      statementId={STATEMENT_ID}
      lineCount={3}
      blockedReason={null}
      confirmMessage="Delete this import and its 3 lines?"
      showDelete
    />,
    messages,
  );
  try {
    const router = (globalThis as unknown as { __dashRouter: { refresh(): void } }).__dashRouter;
    router.refresh = () => {
      refreshed += 1;
    };
    // A declined confirmation sends nothing.
    confirmAnswer(false);
    await click(deleteButton()!);
    await act(async () => {});
    assert.equal(calls.length, 0, "a declined confirmation must not send");
    // An accepted confirmation sends the delete.
    confirmAnswer(true);
    await click(deleteButton()!);
    await act(async () => {});
    assert.ok(
      calls.some((c) => c.method === "DELETE"),
      `the confirm must send DELETE, got ${JSON.stringify(calls)}`,
    );
    assert.ok(
      toasts().some(
        (t) => t.kind === "success" && t.message.includes("Import deleted (3 lines removed)"),
      ),
      `the delete must toast its result, got ${JSON.stringify(toasts())}`,
    );
    assert.equal(refreshed, 1, "the history refreshes after the delete");
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("a refused delete toasts the named remedy", async () => {
  const restoreFetch = scriptFetch((url) =>
    url.includes("/api/banking/statements/")
      ? Response.json(
          { error: "This import has 1 matched line — unmatch it first" },
          { status: 422 },
        )
      : null,
  );
  const { unmount } = await mountDashboard(
    <StatementDeleteCell
      statementId={STATEMENT_ID}
      lineCount={1}
      blockedReason={null}
      confirmMessage="Delete this import and its 1 line?"
      showDelete
    />,
    messages,
  );
  try {
    await click(deleteButton()!);
    await act(async () => {});
    assert.ok(
      toasts().some((t) => t.kind === "error" && t.message.includes("unmatch it first")),
      `the refusal must surface its remedy, got ${JSON.stringify(toasts())}`,
    );
  } finally {
    await unmount();
    restoreFetch();
  }
});

function unmatchButton(): HTMLButtonElement | null {
  return document.querySelector('button[aria-label="Unmatch all"]');
}

// A match-blocked import keeps its disabled delete with the reason, and
// offers Unmatch all beside it so the release — and then the delete — can
// proceed without leaving the history.
test("a match-blocked import offers unmatch-all beside the disabled delete", async () => {
  const calls: { url: string; method?: string }[] = [];
  let refreshed = 0;
  const restoreFetch = scriptFetch((url, init) => {
    if (url.includes(`/api/banking/statements/${STATEMENT_ID}/unmatch-all`)) {
      calls.push({ url, method: init?.method });
      return Response.json({ ok: true, unmatchedGroups: 1, unmatchedLines: 2 });
    }
    return null;
  });
  const { unmount } = await mountDashboard(
    <StatementDeleteCell
      statementId={STATEMENT_ID}
      lineCount={2}
      blockedReason="Has 2 matched lines — unmatch them first"
      confirmMessage="Delete?"
      showDelete
      matchedCount={2}
      unmatchAllConfirmMessage="Unmatch 2 matched lines?"
    />,
    messages,
  );
  try {
    const router = (globalThis as unknown as { __dashRouter: { refresh(): void } }).__dashRouter;
    router.refresh = () => {
      refreshed += 1;
    };
    const blocked = deleteButton();
    assert.ok(blocked, "the blocked import still shows its delete control");
    assert.equal(blocked.disabled, true, "the blocked delete cannot run");
    const release = unmatchButton();
    assert.ok(release, "the match-blocked import offers unmatch-all");
    assert.equal(release.disabled, false, "unmatch-all runs while delete stays disabled");
    confirmAnswer(false);
    await click(release);
    await act(async () => {});
    assert.equal(calls.length, 0, "declining the confirm must send nothing");
    confirmAnswer(true);
    await click(release);
    await act(async () => {});
    assert.ok(
      calls.some((c) => c.method === "POST"),
      `the confirm must POST unmatch-all, got ${JSON.stringify(calls)}`,
    );
    assert.ok(
      toasts().some((t) => t.kind === "success" && t.message.includes("Unmatched 2 lines")),
      `unmatch-all must toast its result, got ${JSON.stringify(toasts())}`,
    );
    assert.equal(refreshed, 1, "the history refreshes after unmatch-all");
  } finally {
    await unmount();
    restoreFetch();
  }
});

test("a non-match block shows no unmatch-all", async () => {
  const { unmount } = await mountDashboard(
    <StatementDeleteCell
      statementId={STATEMENT_ID}
      lineCount={1}
      blockedReason="Has 1 excluded line — restore it first"
      confirmMessage="Delete?"
      showDelete
      matchedCount={0}
      unmatchAllConfirmMessage="Unmatch 0 matched lines?"
    />,
    messages,
  );
  try {
    assert.ok(deleteButton(), "the blocked import still shows its delete control");
    assert.equal(unmatchButton(), null, "unmatch-all hides when no match blocks the delete");
  } finally {
    await unmount();
  }
});
