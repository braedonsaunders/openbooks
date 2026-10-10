// One record, one Save: sections that persist through their own endpoints
// join the record's Save instead of carrying their own.
import assert from "node:assert/strict";
import test from "node:test";
import { bootJsdomEnvironment } from "../testing/jsdom-env";

await bootJsdomEnvironment({ url: "http://localhost:4800/parties", matchMediaMatches: false });

const React = await import("react");
Object.assign(globalThis, { React });
const { createRoot } = await import("react-dom/client");
const { act, useState } = await import("react");
const { RecordSaveContext, useRecordSaveParticipant, useRecordSaveRegistry } = await import("./record-save-participants");

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

type Registry = ReturnType<typeof useRecordSaveRegistry>;
let registry: Registry | null = null;

function Host({ children }: { children: React.ReactNode }) {
  const value = useRecordSaveRegistry();
  registry = value;
  return <RecordSaveContext.Provider value={value.context}>{children}</RecordSaveContext.Provider>;
}

function Section({ name, log, refuse = false }: { name: string; log: string[]; refuse?: boolean }) {
  const [value, setValue] = useState("");
  const [saved, setSaved] = useState("");
  const joined = useRecordSaveParticipant(name, {
    dirty: value !== saved,
    save: async () => {
      log.push(`save:${name}:${value}`);
      if (refuse) return false;
      setSaved(value);
      return true;
    },
    reset: () => {
      log.push(`reset:${name}`);
      setValue(saved);
    },
  });
  return (
    <div data-section={name} data-joined={String(joined)}>
      <input aria-label={name} value={value} onChange={(event) => setValue(event.target.value)} />
    </div>
  );
}

async function render(node: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(node);
    await tick();
  });
  return {
    host,
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
      registry = null;
    },
  };
}

async function type(host: HTMLElement, name: string, value: string) {
  const input = host.querySelector(`input[aria-label="${name}"]`) as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    await tick();
  });
}

test("the record reads dirty from its sections and saves only the dirty ones", async (t) => {
  const log: string[] = [];
  const view = await render(<Host><Section name="relationship" log={log} /><Section name="compliance" log={log} /></Host>);
  t.after(view.done);
  assert.equal(registry!.dirty, false, "untouched sections leave the record clean");
  await type(view.host, "compliance", "C1");
  assert.equal(registry!.dirty, true, "an edited section marks the record dirty");
  let result: Awaited<ReturnType<Registry["saveAll"]>> | null = null;
  await act(async () => {
    result = await registry!.saveAll();
    await tick();
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(log, ["save:compliance:C1"], "a clean section is never written");
  assert.equal(registry!.dirty, false, "a saved section reads clean");
});

test("a refused section stops the save and names itself so the record can show it", async (t) => {
  const log: string[] = [];
  const view = await render(<Host><Section name="relationship" log={log} refuse /><Section name="compliance" log={log} /></Host>);
  t.after(view.done);
  await type(view.host, "relationship", "Software");
  await type(view.host, "compliance", "C1");
  let result: Awaited<ReturnType<Registry["saveAll"]>> | null = null;
  await act(async () => {
    result = await registry!.saveAll();
    await tick();
  });
  assert.deepEqual(result, { ok: false, key: "relationship" });
  assert.deepEqual(log, ["save:relationship:Software"], "sections after a refusal are not written");
  assert.equal(registry!.dirty, true, "the refused edits stay on the record");
});

test("discarding the record resets every section", async (t) => {
  const log: string[] = [];
  const view = await render(<Host><Section name="relationship" log={log} /></Host>);
  t.after(view.done);
  await type(view.host, "relationship", "Software");
  await act(async () => {
    registry!.resetAll();
    await tick();
  });
  assert.deepEqual(log, ["reset:relationship"]);
  assert.equal((view.host.querySelector('input[aria-label="relationship"]') as HTMLInputElement).value, "");
  assert.equal(registry!.dirty, false);
});

test("a section outside a record drawer knows it has no Save to join", async (t) => {
  const view = await render(<Section name="relationship" log={[]} />);
  t.after(view.done);
  assert.equal(view.host.querySelector("[data-section]")?.getAttribute("data-joined"), "false");
});
