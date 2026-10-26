import { isUuid } from "../platform/uuid.ts";
import { PayrollError } from "./error.ts";

export type RoeEventSelection = { employeePartyId: string; eventId: string | null };
export function parseRoeEventRow(rowId: string): RoeEventSelection | null {
  const parts = rowId.split("~");
  if (parts.length > 2 || !isUuid(parts[0]) || (parts.length === 2 && !isUuid(parts[1])))
    return null;
  return { employeePartyId: parts[0]!, eventId: parts[1] ?? null };
}
export function roeEventRow(employeePartyId: string, eventId: string): string {
  if (!isUuid(employeePartyId) || !isUuid(eventId))
    throw new PayrollError("Choose the native employee and separation event");
  return employeePartyId + "~" + eventId;
}
