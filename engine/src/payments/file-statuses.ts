/**
 * Every payment_files.status the engine can write: the seven drizzle-level
 * states plus the two delivery-claim states. The RunDrawer fileStatus catalog
 * must label every member in every locale. Extend this list when a new state
 * is introduced.
 */
export const PAYMENT_FILE_STATUSES = [
  "generated",
  "pending_approval",
  "approved",
  "rejected",
  "delivered",
  "superseded",
  "voided",
  "delivering",
  "delivery_uncertain",
] as const;
