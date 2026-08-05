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
  const installer = readFileSync("scripts/compose-up.sh", "utf8");
  const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  assert.match(
    compose,
    /image: \$\{OPENBOOKS_IMAGE:\?OPENBOOKS_IMAGE must be a post-clean, scanned image pinned by digest\}/,
  );
  assert.doesNotMatch(compose, /ghcr\.io\/braedonsaunders\/openbooks/);
  assert.match(readme, /### One-command Docker Compose installation/);
  assert.match(readme, /\.\/scripts\/compose-up\.sh/);
  assert.match(readme, /OPENBOOKS_IMAGE='[^']+@sha256:[^']+'/);
  assert.match(
    installer,
    new RegExp(`official_openbooks_image=ghcr\\.io/braedonsaunders/openbooks:${packageVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  assert.match(installer, /docker pull "\$official_openbooks_image"/);
  assert.match(installer, /docker image inspect "\$official_openbooks_image"/);
  assert.match(installer, /configured_openbooks_image=\$\([\s\S]*?@sha256/);
  assert.match(installer, /OPENBOOKS_IMAGE=\$configured_openbooks_image/);
});
