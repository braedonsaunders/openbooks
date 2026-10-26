import assert from "node:assert/strict";
import test from "node:test";
import { childCommands } from "./commands";
import type {
  ManufacturingOptions,
  ManufacturingRow,
} from "@openbooks/engine/manufacturing/workspace";

const order = {
  id: "wo-1",
  status: "in_progress",
  plannedStart: "2026-03-02",
} as unknown as ManufacturingRow;
const options = {} as ManufacturingOptions;

function completeFields(row: Record<string, unknown>) {
  const commands = childCommands(
    "work-orders",
    "operations",
    order,
    row as ManufacturingRow,
    options,
    true,
    false,
  );
  const complete = commands.find((command) => command.key === "completeOperation");
  assert.ok(complete, "a running operation offers Complete");
  return new Map(complete.fields.map((field) => [field.key, field.initial]));
}

test("completing an operation opens with the routing's standard minutes visible", () => {
  // A blank actual would be costed at standard without the operator seeing
  // it; the dialog shows the standard so it is confirmed or overridden.
  const fields = completeFields({
    id: "op-1",
    status: "running",
    quantityPlanned: "10.0000",
    quantityScrappedHere: "2.0000",
    plannedSetupMinutes: "15.0000",
    plannedRunMinutes: "50.0000",
    actualSetupMinutes: null,
    actualRunMinutes: null,
    laborTimeSource: "operation",
  });
  assert.equal(fields.get("actualSetupMinutes"), "15.0000");
  assert.equal(
    fields.get("actualRunMinutes"),
    "40.0000",
    "run standard scales to the default done quantity",
  );
});

test("previously reported minutes win over the routing standard", () => {
  const fields = completeFields({
    id: "op-2",
    status: "running",
    quantityPlanned: "10.0000",
    quantityScrappedHere: "0",
    plannedSetupMinutes: "15.0000",
    plannedRunMinutes: "50.0000",
    actualSetupMinutes: "0.0000",
    actualRunMinutes: "61.5000",
    laborTimeSource: "operation",
  });
  assert.equal(fields.get("actualSetupMinutes"), "0.0000");
  assert.equal(fields.get("actualRunMinutes"), "61.5000");
});

test("confirmed MRP purchase orders expose conversion only to authorized buyers", () => {
  const run = { id: "mrp-1", status: "complete" } as unknown as ManufacturingRow;
  const suggestion = {
    id: "planned-1",
    status: "confirmed",
    action: "buy",
  } as unknown as ManufacturingRow;
  const mrpOptions = { vendors: [] } as unknown as ManufacturingOptions;

  assert.equal(
    childCommands("mrp", "suggestions", run, suggestion, mrpOptions, false, false).some(
      (command) => command.key === "convert",
    ),
    false,
  );
  assert.equal(
    childCommands("mrp", "suggestions", run, suggestion, mrpOptions, false, true).some(
      (command) => command.key === "convert",
    ),
    true,
  );
});
