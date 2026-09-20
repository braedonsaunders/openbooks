import assert from "node:assert/strict";
import test from "node:test";
import { classifyAssetFromContext, type RegimeClassSpec } from "./tax-classification.ts";

const pool = (code: "uk_wda" | "au_pool" | "nz_pool", classes: string[]): RegimeClassSpec => ({
  code,
  name: code,
  classAttribute: "tax_pool_class",
  validClasses: new Set(classes),
});

test("a shared tax_pool_class=lvp classifies only the regime whose class table contains lvp", () => {
  const classified = classifyAssetFromContext(
    {},
    { tax_pool_class: "lvp" },
    [
      pool("uk_wda", ["main", "special"]),
      pool("au_pool", ["sbp", "lvp"]),
      pool("nz_pool", ["pool"]),
    ],
  );
  assert.deepEqual(classified.map((row) => row.code), ["au_pool"]);
});

test("an uninstalled or invalid class does not invent a regime", () => {
  assert.deepEqual(
    classifyAssetFromContext({}, { tax_pool_class: "lvp" }, [pool("uk_wda", ["main", "special"])]),
    [],
  );
  assert.deepEqual(
    classifyAssetFromContext({}, { ca_cca_class: "8" }, [
      { code: "ca_cca", name: "CCA", classAttribute: "ca_cca_class", validClasses: new Set(["8", "10"]) },
    ]).map((row) => row.classCode),
    ["8"],
  );
});
