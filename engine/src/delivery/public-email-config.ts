/** Per-org mail transport resolution and delivery logging for route-side sends. */
export {
  insertEmailLog,
  markEmailFailed,
  markEmailSent,
  markEmailUncertain,
  resolveOrgEmailTransport,
  resolveOrgEmailTransportDetailed,
} from "./email-config.ts";
