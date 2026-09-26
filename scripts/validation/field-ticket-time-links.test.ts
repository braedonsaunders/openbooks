import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTimeTicketLinks,
  type ResolvedLink,
} from "./field-ticket-time-links.ts";

function row(overrides: Partial<ResolvedLink>): ResolvedLink {
  return {
    sourceRef: "SRC-1",
    ticketNumber: "FT-1",
    timeEntryId: null,
    currentTicketId: null,
    currentTicketNumber: null,
    targetTicketId: null,
    entryProjectId: null,
    ticketProjectId: null,
    protectedEvidence: false,
    ...overrides,
  };
}

test("a row missing both the entry and the ticket counts once, never -1", () => {
  const resolved = [
    row({ sourceRef: "SRC-unknown", ticketNumber: "FT-unknown" }),
  ];
  const classified = classifyTimeTicketLinks(resolved, 1, 1);
  assert.equal(classified.missingTimeEntries.length, 1);
  assert.equal(classified.missingTickets.length, 0);
  assert.equal(classified.summary.exactCurrentLinks, 0);
  assert.equal(
    classified.summary.missingTimeEntries +
      classified.summary.missingTickets +
      classified.summary.requiredChanges +
      classified.summary.exactCurrentLinks,
    resolved.length,
  );
});

test("the classification partitions every input row exactly once", () => {
  const resolved = [
    // missing entry (ticket also unknown) -> missing-time only
    row({ sourceRef: "SRC-a", ticketNumber: "FT-a" }),
    // entry present, ticket unknown -> missing-ticket
    row({
      sourceRef: "SRC-b",
      ticketNumber: "FT-b",
      timeEntryId: "te-b",
      entryProjectId: "p1",
    }),
    // entry + ticket, already linked -> exact
    row({
      sourceRef: "SRC-c",
      ticketNumber: "FT-c",
      timeEntryId: "te-c",
      currentTicketId: "t-c",
      currentTicketNumber: "FT-c",
      targetTicketId: "t-c",
      entryProjectId: "p1",
      ticketProjectId: "p1",
    }),
    // entry + ticket, different ticket -> change
    row({
      sourceRef: "SRC-d",
      ticketNumber: "FT-d",
      timeEntryId: "te-d",
      currentTicketId: "t-old",
      currentTicketNumber: "FT-old",
      targetTicketId: "t-new",
      entryProjectId: "p1",
      ticketProjectId: "p1",
    }),
  ];
  const classified = classifyTimeTicketLinks(resolved, 4, 4);
  assert.equal(classified.summary.missingTimeEntries, 1);
  assert.equal(classified.summary.missingTickets, 1);
  assert.equal(classified.summary.requiredChanges, 1);
  assert.equal(classified.summary.exactCurrentLinks, 1);
});
