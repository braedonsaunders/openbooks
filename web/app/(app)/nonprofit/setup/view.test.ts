import assert from "node:assert/strict";
import test from "node:test";

const { stubModules } = await import("../../../../testing/stub-modules");
stubModules({
  navigation: true,
  intl: true,
  authz: true,
  features: true,
  extra: { "server-only": "export {}" },
});
const { nonprofitSetupSpec } = await import("./view");

type Data = Parameters<typeof nonprofitSetupSpec>[0];
type Node = Record<string, unknown>;

function collect(node: unknown, match: (node: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) for (const item of node) collect(item, match, out);
  else if (node && typeof node === "object") {
    if (match(node as Node)) out.push(node as Node);
    for (const value of Object.values(node)) collect(value, match, out);
  }
  return out;
}

test("nonprofit setup renders only the selected entity section and carries its namespaced drawer state", () => {
  const sectionParams = { section: "pairs", prow: "new" };
  const spec = nonprofitSetupSpec({
    activeSection: "pairs",
    sectionParams,
    sectionTabs: [
      { href: "/nonprofit/setup?section=framework", label: "Framework" },
      { href: "/nonprofit/setup?section=pairs", label: "Fund pairs", active: true },
      { href: "/nonprofit/setup?section=mappings", label: "Functional mappings" },
    ],
  } as unknown as Data);

  const body = (spec as { body: unknown }).body;
  const sections = collect(body, (node) => node.widget === "setup-section");
  assert.equal(sections.length, 1);
  assert.deepEqual(sections[0]?.props, {
    entityKey: "fund-pairs",
    basePath: "/nonprofit/setup",
    sp: sectionParams,
    rowParam: "prow",
  });
  assert.ok(
    collect(body, (node) => node.widget === "module-home-tabs").some((node) => {
      const props = node.props as Record<string, unknown> | undefined;
      return props?.placement === "local";
    }),
    "peer setup sections use local tabs",
  );
});
