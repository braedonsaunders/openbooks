import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { TAX_RETURN_PACKS } from "../seed-tax-forms.ts";

const readme = readFileSync("README.md", "utf8");

test("README screenshots and animated repository cards resolve to tracked assets", () => {
  const sources = [
    ...readme.matchAll(/(?:src|srcset)="([^"#?]+)"/g),
  ].map((match) => match[1]!).filter((source) => !source.startsWith("http"));
  assert.ok(sources.includes(".github/codeflow-card.svg"));
  for (const source of sources) {
    assert.ok(existsSync(source), `README asset does not exist: ${source}`);
  }
});

test("README tax-pack count follows the executable catalog", () => {
  const count = readme.match(/A (\d+)-pack return-workpaper library/)?.[1];
  assert.ok(count, "README must state the return-workpaper catalog size");
  assert.equal(Number(count), TAX_RETURN_PACKS.length);
});

test("README connector, locale, and container claims match shipped files", () => {
  const connectorFiles: Record<string, string> = {
    NetSuite: "engine/src/netsuite.ts",
    "QuickBooks Online": "engine/src/qbo.ts",
    "QuickBooks Desktop Web Connector": "engine/src/qbd",
    Xero: "engine/src/xero.ts",
    ERPNext: "engine/src/erpnext.ts",
    Odoo: "engine/src/odoo.ts",
    "Microsoft Dynamics": "engine/src/dynamics.ts",
  };
  for (const [name, path] of Object.entries(connectorFiles)) {
    assert.match(readme, new RegExp(`- ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.ok(existsSync(path), `README connector has no implementation path: ${name}`);
  }

  for (const locale of ["en", "fr", "es", "de", "pt-BR", "zh", "ja"]) {
    assert.ok(existsSync(`web/messages/${locale}`), `missing locale catalog: ${locale}`);
  }

  const compose = readFileSync("compose.yaml", "utf8");
  assert.match(compose, /ghcr\.io\/braedonsaunders\/openbooks:\$\{OPENBOOKS_IMAGE_TAG:-latest\}/);
  assert.match(readme, /ghcr\.io\/braedonsaunders\/openbooks:latest/);
});
