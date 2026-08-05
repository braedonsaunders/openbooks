import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { auditColumns, id, orgRef } from "./helpers";

/** One read-only QuickBooks Desktop extraction capture. */
export const qbdCaptures = pgTable(
  "qbd_captures",
  {
    id: id(),
    orgId: orgRef(),
    connectionId: uuid("connection_id").notNull(),
    status: text("status", { enum: ["queued", "running", "complete", "failed", "cancelled"] }).notNull().default("queued"),
    since: timestamp("since", { withTimezone: true }),
    capturedThrough: timestamp("captured_through", { withTimezone: true }).notNull(),
    progress: jsonb("progress").notNull().default({}),
    errorMessage: text("error_message"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("qbd_captures_connection").on(t.connectionId, t.createdAt),
    index("qbd_captures_expiry").on(t.expiresAt),
  ],
);

/** One qbXML request/response page; raw responses are erased after ingestion. */
export const qbdRequests = pgTable(
  "qbd_requests",
  {
    id: id(),
    orgId: orgRef(),
    connectionId: uuid("connection_id").notNull(),
    captureId: uuid("capture_id").notNull(),
    family: text("family").notNull(),
    requestKind: text("request_kind").notNull(),
    sequence: integer("sequence").notNull(),
    page: integer("page").notNull().default(0),
    status: text("status", { enum: ["queued", "sent", "complete", "failed", "cancelled"] }).notNull().default("queued"),
    requestXml: text("request_xml").notNull(),
    responseXml: text("response_xml"),
    responseSha256: text("response_sha256"),
    sessionId: uuid("session_id"),
    errorMessage: text("error_message"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...auditColumns,
  },
  (t) => [
    index("qbd_requests_next").on(t.connectionId, t.status, t.sequence),
    index("qbd_requests_capture").on(t.captureId, t.family, t.page),
    uniqueIndex("qbd_requests_capture_sequence").on(t.captureId, t.sequence),
  ],
);

/** Authenticated QuickBooks Web Connector SOAP session (ticket). */
export const qbdSessions = pgTable(
  "qbd_sessions",
  {
    id: id(),
    orgId: orgRef(),
    connectionId: uuid("connection_id").notNull(),
    status: text("status", { enum: ["open", "closed", "error"] }).notNull().default("open"),
    companyFile: text("company_file"),
    country: text("country"),
    qbxmlMajor: integer("qbxml_major"),
    qbxmlMinor: integer("qbxml_minor"),
    lastError: text("last_error"),
    authenticatedAt: timestamp("authenticated_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("qbd_sessions_connection").on(t.connectionId, t.authenticatedAt),
    index("qbd_sessions_expiry").on(t.expiresAt),
  ],
);

// FKs (referential-integrity.sql): every table → orgs/connections;
// qbd_requests.capture_id → qbd_captures; qbd_requests.session_id → qbd_sessions.
