import { sql } from "drizzle-orm";
import { db } from "../../platform/db.ts";
import { hashDeviceToken } from "./pins.ts";
import { refuse } from "./errors.ts";

/** Hold the same row lock that revokeKiosk's FOR UPDATE must acquire. */
export async function lockActiveKioskToken(input: {
  orgId: string;
  kioskId: string;
  deviceToken: string;
}): Promise<void> {
  const row = (await db.execute<{ id: string }>(sql`
    select id from time_kiosks
     where org_id = ${input.orgId} and id = ${input.kioskId}
       and device_token_hash = ${hashDeviceToken(input.deviceToken)} and is_active
     for share`)).rows[0];
  if (!row) {
    refuse("kiosk_unknown", "This kiosk link is unknown or retired — ask a manager for a current kiosk link");
  }
}
