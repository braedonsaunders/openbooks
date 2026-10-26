import assert from "node:assert/strict";
import test from "node:test";
import { parseRoeEventRow, roeEventRow } from "./roe-event-row.ts";
const employee = "00000000-0000-4000-8000-000000000001",
  event = "00000000-0000-4000-8000-000000000002";
test("ROE selections retain exact event identity and reject malformed or extra identities", () => {
  assert.deepEqual(parseRoeEventRow(roeEventRow(employee, event)), {
    employeePartyId: employee,
    eventId: event,
  });
  for (const row of [
    "",
    employee + "~",
    employee + "~not-an-event",
    employee + "~" + event + "~" + event,
    event + ":A",
  ])
    assert.equal(parseRoeEventRow(row), null);
});
test("legacy employee keys remain explicit unbound selections instead of inventing an event", () => {
  assert.deepEqual(parseRoeEventRow(employee), { employeePartyId: employee, eventId: null });
  assert.throws(() => roeEventRow(employee, ""), /native employee and separation event/);
});
