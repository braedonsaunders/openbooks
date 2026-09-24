import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// CK-09: three setup sections share one page URL (?row=new opened all three
// drawers at once). Each section now reads its own drawer key.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
  url: "http://localhost:4800/hrm/documents",
});
const globals = globalThis as Record<string, unknown>;
const domWindow = dom.window as unknown as Record<string, unknown>;
for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Event", "self"]) {
  if (globals[key] === undefined) globals[key] = domWindow[key];
}
if (typeof window.matchMedia !== "function") {
  window.matchMedia = (() => ({
    matches: true,
    media: "",
    addEventListener() {},
    removeEventListener() {},
  })) as typeof window.matchMedia;
}

const React = await import("react");
// The shared @openbooks/ui controls compile against a global React.
Object.assign(globalThis, { React });
(globals as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// The seams below stub I/O only (the database transport, feature switches,
// ref options, navigation, the server-only marker); translations ride the
// REAL en catalogs and the registry, spec builders, and section/drawer
// components are all real.
const adminCatalog = (await import("../../../../messages/en/admin.json", { with: { type: "json" } })).default;
const allMessages = (await import("../../../../messages/en")).default;
globals.__docSecCatalogs = { admin: adminCatalog };

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next/navigation") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export function useRouter() { return { push() {}, replace() {}, refresh() {} }; }
             export function usePathname() { return "/hrm/documents"; }
             export function useSearchParams() { return { get() { return null; }, toString() { return ""; } }; }
             export function redirect() { throw new Error("redirect"); }
             export function notFound() { throw new Error("not-found"); }`,
          ),
      };
    }
    const parent = context.parentURL ?? "";
    if (specifier === "next-intl/server") {
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export async function getTranslations(ns) {
              const root = { admin: globalThis.__docSecCatalogs.admin };
              const lookup = (key) => {
                let node = root;
                for (const part of String(ns + "." + key).split(".")) {
                  if (node !== null && typeof node === "object") node = node[part];
                  else return key;
                }
                return typeof node === "string" ? node : key;
              };
              const t = (key, params) => {
                const template = lookup(key);
                if (!params) return template;
                return template.replace(/\\{(\\w+)\\}/g, (_, name) => (params[name] === undefined ? "{" + name + "}" : String(params[name])));
              };
              t.has = (key) => lookup(key) !== key;
              return t;
            }`,
          ),
      };
    }
    // NOTE: parentURL percent-encodes the [entity] segment, so match the
    // file name, never the bracketed directory.
    if (
      parent.includes("SetupEntitySection.tsx") &&
      (specifier === "@openbooks/engine/src/platform/db.ts" ||
        specifier.endsWith("/lib/features") ||
        specifier.endsWith("/lib/setup/ref-options"))
    ) {
      if (specifier === "@openbooks/engine/src/platform/db.ts") {
        return {
          shortCircuit: true,
          format: "module",
          url:
            "data:text/javascript," +
            encodeURIComponent(
              `export const db = { execute: async () => {
                const plan = globalThis.__docSecDbPlan ?? [];
                return plan.length ? plan.shift() : { rows: [] };
              } };`,
            ),
        };
      }
      if (specifier.endsWith("/lib/features")) {
        return {
          shortCircuit: true,
          format: "module",
          url: "data:text/javascript,export async function isFeatureEnabled() { return false; } export async function subsidiaryFeatureEnabled() { return false; }",
        };
      }
      // Re-export the real module and override only the DB-backed option
      // loader; orderExpr and friends stay the product code, never a copy.
      const realRefOptions = new URL("../../../../../lib/setup/ref-options.ts", parent).href;
      return {
        shortCircuit: true,
        format: "module",
        url:
          "data:text/javascript," +
          encodeURIComponent(
            `export * from ${JSON.stringify(realRefOptions)};
             export async function loadRefOptions() { return {}; }`,
          ),
      };
    }
    return next(specifier, context);
  },
});

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { NextIntlClientProvider } = await import("next-intl");
const { SETUP_ENTITY_BY_KEY } = await import("../../../../lib/setup/registry");
const { SetupEntitySection } = await import("../../admin/setup/[entity]/SetupEntitySection");

const SECTIONS = [
  { entityKey: "hrm-document-templates", rowParam: "template" },
  { entityKey: "hrm-document-categories", rowParam: "category" },
  { entityKey: "hrm-retention-schedules", rowParam: "retention" },
] as const;

const script = {
  readBackRow: null as unknown as Record<string, unknown>,
};

function planDb(plan: { rows: unknown[] }[]): void {
  (globalThis as Record<string, unknown>).__docSecDbPlan = [...plan];
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Mount every section against the same URL params; count role=dialog per section. */
async function renderSections(sp: Record<string, string>): Promise<{ counts: number[]; bodies: string[] }> {
  const counts: number[] = [];
  const bodies: string[] = [];
  for (const section of SECTIONS) {
    // List rows, list count; the row read-back (when the drawer key holds
    // an id) is the third transport call.
    const key = sp[section.rowParam];
    planDb(
      key !== undefined && key !== "new"
        ? [{ rows: [] }, { rows: [{ n: "0" }] }, { rows: [script.readBackRow] }]
        : [{ rows: [] }, { rows: [{ n: "0" }] }],
    );
    const entity = SETUP_ENTITY_BY_KEY.get(section.entityKey);
    assert.ok(entity, `the registry knows ${section.entityKey}`);
    const node = await SetupEntitySection({
      entity,
      orgId: "org-1",
      searchParams: sp,
      basePath: "/hrm/documents",
      canManage: true,
      rowParam: section.rowParam,
    });
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="en" messages={allMessages} timeZone="UTC">
          {node}
        </NextIntlClientProvider>,
      );
      await tick();
      await tick();
    });
    // Drawers portal into document.body, so count and read from the whole
    // document; each section mounts alone and unmounts before the next.
    counts.push(document.querySelectorAll('[role="dialog"]').length);
    bodies.push(document.body.innerHTML);
    await act(async () => {
      root.unmount();
    });
    host.remove();
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 0, "unmounting takes the drawer with it");
  }
  return { counts, bodies };
}

// -- spec wiring: one URL addresses one section ------------------------------

interface SpecNode {
  widget?: string;
  props?: { entityKey?: string; rowParam?: string };
  blocks?: SpecNode[];
  body?: SpecNode[];
}

function setupSectionBlocks(node: unknown, out: SpecNode[] = []): SpecNode[] {
  if (Array.isArray(node)) {
    for (const child of node) setupSectionBlocks(child, out);
  } else if (node !== null && typeof node === "object") {
    const record = node as SpecNode;
    if (record.widget === "setup-section") out.push(record);
    setupSectionBlocks(record.blocks, out);
    setupSectionBlocks(record.body, out);
  }
  return out;
}

test("the documents spec gives each setup section its own drawer key", async () => {
  const { documentsSpec } = await import("./view.ts");
  const data = {
    currentParams: { template: "new" },
    tabs: [],
    viewTabs: [],
    segmentsLabel: "",
    allLabel: "",
    segmentOptions: [],
    columns: { title: "", person: "", category: "", sent: "", expires: "", status: "" },
  };
  const spec = documentsSpec(data as never);
  const blocks = setupSectionBlocks(spec);
  assert.deepEqual(
    blocks.map((b) => [b.props?.entityKey, b.props?.rowParam]),
    [
      ["hrm-document-templates", "template"],
      ["hrm-document-categories", "category"],
      ["hrm-retention-schedules", "retention"],
    ],
    "each section reads only its own URL key",
  );
});

// -- render: exactly one drawer opens ------------------------------------------

test("?template=new opens only the templates drawer", async () => {
  const { counts } = await renderSections({ template: "new" });
  assert.deepEqual(counts, [1, 0, 0], "exactly one role=dialog mounts, in the templates section");
});

test("?category=new opens only the categories drawer", async () => {
  const { counts } = await renderSections({ category: "new" });
  assert.deepEqual(counts, [0, 1, 0], "exactly one role=dialog mounts, in the categories section");
});

test("?retention=new opens only the retention drawer", async () => {
  const { counts } = await renderSections({ retention: "new" });
  assert.deepEqual(counts, [0, 0, 1], "exactly one role=dialog mounts, in the retention section");
});

test("the legacy bare ?row=new no longer fans out to every section", async () => {
  const { counts } = await renderSections({ row: "new" });
  assert.deepEqual(counts, [0, 0, 0], "no section reads the shared key anymore");
});

// -- render: direct links read the saved record back ----------------------------

test("a direct link to a saved template reads the record back", async () => {
  script.readBackRow = {
    id: "tpl-1",
    name: "READBACK TEMPLATE",
    category_key: "cat-1",
    body_template: "hello",
    is_active: true,
  };
  const { counts, bodies } = await renderSections({ template: "tpl-1" });
  assert.deepEqual(counts, [1, 0, 0], "exactly one role=dialog mounts, in the templates section");
  assert.ok(bodies[0]?.includes("READBACK TEMPLATE") ?? false, "the drawer shows the saved record, not a blank form");
});
