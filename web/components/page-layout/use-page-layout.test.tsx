import assert from "node:assert/strict";
import test from "node:test";

// LAYOUT1: two tabs race whole-layout saves with inverted commit order — the
// tab whose request commits second must 409, merge to the union, and retry,
// so both hides survive server-side.
// LAYOUT2: a 500 and a rejected fetch each surface the named error, keep the
// change pending (no silent rollback), and a retry saves it.

// jsdom first: the hook test renders through react-dom.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/banking",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const { usePageLayout } = await import("./use-page-layout");

const tick = () => new Promise((resolve) => setTimeout(resolve, 25));

interface ServerState {
  layout: { hidden?: string[]; order?: string[] };
  revision: string;
}
let server: ServerState;
let revN: number;

interface PutCall {
  body: { page: string; layout: { hidden?: string[] }; expectedRevision: string | null };
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}
let putQueue: PutCall[] = [];
/** When set, every PUT fails this way instead of reaching the emulator. */
let putFailure: { status: number; body: unknown } | { reject: unknown } | null = null;

function resetServer(): void {
  server = { layout: {}, revision: "rev-0" };
  revN = 0;
  putQueue = [];
  putFailure = null;
}

function casRespond(body: PutCall["body"]): Response {
  if (body.expectedRevision !== server.revision) {
    return Response.json(
      {
        error: "this page layout changed after you opened it; the current layout is returned",
        current: { layout: server.layout, revision: server.revision },
      },
      { status: 409 },
    );
  }
  revN += 1;
  server = { layout: body.layout, revision: `rev-${revN}` };
  return Response.json({ ok: true, layout: body.layout, revision: server.revision });
}

const priorFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!init || !init.method || init.method === "GET") {
    return Response.json({ layout: server.layout, revision: server.revision });
  }
  if (putFailure && "reject" in putFailure) {
    throw putFailure.reject;
  }
  if (putFailure && "status" in putFailure) {
    return Response.json(putFailure.body, { status: putFailure.status });
  }
  const body = JSON.parse(String(init.body)) as PutCall["body"];
  return new Promise<Response>((resolve, reject) => {
    putQueue.push({ body, resolve, reject });
  });
}) as typeof fetch;

function Probe({ id }: { id: string }) {
  const layout = usePageLayout("banking-accounts", {}, ["a", "b"]);
  const hidden = [...layout.hidden].sort().join(",");
  return (
    <div data-probe={id}>
      <span data-s="hidden">{hidden}</span>
      <span data-s="saveState">{layout.saveState}</span>
      <span data-s="saveError">{layout.saveError ?? ""}</span>
      <button data-op="toggle-a" type="button" onClick={() => layout.toggle("a")}>
        toggle-a
      </button>
      <button data-op="toggle-b" type="button" onClick={() => layout.toggle("b")}>
        toggle-b
      </button>
      <button data-op="retry" type="button" onClick={() => layout.retry()}>
        retry
      </button>
    </div>
  );
}

async function mountProbe(id: string): Promise<{ container: HTMLElement; unmount: () => Promise<void> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<Probe id={id} />);
    await tick();
    await tick();
  });
  await tick();
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function text(container: HTMLElement, which: string): string {
  return container.querySelector(`[data-s="${which}"]`)?.textContent ?? "";
}

async function click(container: HTMLElement, op: string): Promise<void> {
  const button = container.querySelector(`[data-op="${op}"]`) as HTMLButtonElement;
  assert.ok(button, `button ${op} exists`);
  await act(async () => {
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await tick();
  });
  await tick();
}

/** Settle one queued PUT through the CAS emulator (or fail it when armed). */
async function settleNextPut(): Promise<void> {
  await act(async () => {
    const call = putQueue.shift();
    assert.ok(call, "a PUT must be in flight");
    call.resolve(casRespond(call.body));
    await tick();
  });
  await tick();
}

test("inverted commit order across tabs ends with both hides saved", async () => {
  resetServer();
  const tab1 = await mountProbe("tab1");
  const tab2 = await mountProbe("tab2");
  await tick();
  await tick();

  await click(tab1.container, "toggle-a");
  await click(tab2.container, "toggle-b");
  assert.equal(putQueue.length, 2, "each tab has one save in flight");

  // Request B commits first; the delayed request A arrives on a stale token.
  const second = putQueue[1]!;
  const first = putQueue[0]!;
  putQueue = [];
  await act(async () => {
    second.resolve(casRespond(second.body));
    await tick();
  });
  await tick();
  assert.equal(text(tab2.container, "saveState"), "saved");
  await act(async () => {
    first.resolve(casRespond(first.body));
    await tick();
  });
  await tick();
  await tick();
  // Tab 1 reconciles the 409 to the union and retries exactly once.
  assert.equal(putQueue.length, 1, "the 409 triggers one reconciling retry");
  await settleNextPut();

  assert.deepEqual([...(server.layout.hidden ?? [])].sort(), ["a", "b"]);
  assert.equal(text(tab1.container, "saveState"), "saved");
  assert.equal(text(tab1.container, "saveError"), "");
  assert.equal(text(tab1.container, "hidden"), "a,b");
  assert.equal(text(tab2.container, "saveState"), "saved");

  await tab1.unmount();
  await tab2.unmount();
});

test("a 500 shows the named error, keeps the change pending, and retry saves it", async () => {
  resetServer();
  const tab = await mountProbe("tab");
  await tick();
  await tick();

  putFailure = { status: 500, body: { error: "storage blew up" } };
  await click(tab.container, "toggle-a");

  assert.equal(text(tab.container, "saveState"), "error");
  assert.match(text(tab.container, "saveError"), /storage blew up/);
  assert.equal(text(tab.container, "hidden"), "a", "the unsaved change stays visible and pending");

  putFailure = null;
  await click(tab.container, "retry");
  assert.equal(putQueue.length, 1, "retry re-sends the pending change");
  await settleNextPut();

  assert.equal(text(tab.container, "saveState"), "saved");
  assert.equal(text(tab.container, "saveError"), "");
  assert.deepEqual(server.layout.hidden, ["a"]);

  await tab.unmount();
});

test("a rejected fetch shows a connection error, keeps the change, and retry saves it", async () => {
  resetServer();
  const tab = await mountProbe("tab");
  await tick();
  await tick();

  putFailure = { reject: new TypeError("fetch failed") };
  await click(tab.container, "toggle-b");

  assert.equal(text(tab.container, "saveState"), "error");
  assert.match(text(tab.container, "saveError"), /connection/);
  assert.equal(text(tab.container, "hidden"), "b", "the unsaved change stays visible and pending");

  putFailure = null;
  await click(tab.container, "retry");
  await settleNextPut();

  assert.equal(text(tab.container, "saveState"), "saved");
  assert.deepEqual(server.layout.hidden, ["b"]);

  await tab.unmount();
  globalThis.fetch = priorFetch;
});
