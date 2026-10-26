import assert from "node:assert/strict";
import test from "node:test";
import { manufacturingModuleTabs, type ManufacturingTabLabels } from "./manufacturing-tabs";

const labels: ManufacturingTabLabels = {
  home: "Manufacturing",
  "work-orders": "Work orders",
  "work-centers": "Work centers",
  routings: "Routings",
  mrp: "MRP",
  quality: "Quality",
  genealogy: "Genealogy",
  time: "Production time",
};

test("manufacturing tabs omit inaccessible routes and retain selected legal entity", () => {
  const tabs = manufacturingModuleTabs("quality", labels, {
    mrp: false,
    quality: true,
    genealogy: false,
    time: false,
    subsidiaryId: "123e4567-e89b-42d3-a456-426614174000",
  });
  assert.deepEqual(
    tabs.map(({ href }) => href),
    [
      "/manufacturing?sub=123e4567-e89b-42d3-a456-426614174000",
      "/manufacturing/work-orders?sub=123e4567-e89b-42d3-a456-426614174000",
      "/manufacturing/work-centers?sub=123e4567-e89b-42d3-a456-426614174000",
      "/manufacturing/routings?sub=123e4567-e89b-42d3-a456-426614174000",
      "/manufacturing/quality?sub=123e4567-e89b-42d3-a456-426614174000",
    ],
  );
  assert.equal(
    tabs.find((tab) => tab.active)?.href,
    "/manufacturing/quality?sub=123e4567-e89b-42d3-a456-426614174000",
  );
});
