import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  bookReplicationStatus,
  changeBookReplication,
  listBookReplicationRuns,
} from "@openbooks/engine/multibook";

export const runtime = "nodejs";

const changeBody = z
  .object({
    bookId: uuidString(),
    kind: z.enum(["activation", "catch_up", "deactivation", "settings"]),
    replicationFrom: z.string().nullable().optional(),
    openingStrategy: z.enum(["full_history", "opening_balances"]).nullable().optional(),
    currencyDifferenceAccountId: uuidString().nullable().optional(),
    reason: z.string(),
  })
  .strict();

/** Each secondary book's replication state and completeness, with the change history. */
export const GET = defineRoute({
  permission: "gl.read",
  feature: "multiBookAccounting",
  handler: async ({ authz }) => {
    const orgId = authz.user.orgId;
    const [books, runs] = [
      await bookReplicationStatus(orgId, await businessToday(orgId)),
      await listBookReplicationRuns(orgId),
    ];
    return NextResponse.json({ books, runs });
  },
});

/**
 * Record a governed replication change: activate full replication (with
 * its backfill from the chosen date and opening strategy), catch up,
 * deactivate, or set the book's currency difference account.
 */
export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiBookAccounting",
  scope: "unrestricted",
  body: changeBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, body }) => {
    const { reason, ...input } = body;
    const run = await changeBookReplication({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      input: {
        ...input,
        ...(input.openingStrategy === null ? { openingStrategy: undefined } : {}),
        // Only a settings change can clear the account; an empty account on
        // any other change keeps the book's current one.
        ...(input.currencyDifferenceAccountId === undefined ||
        (input.currencyDifferenceAccountId === null && input.kind !== "settings")
          ? { currencyDifferenceAccountId: undefined }
          : { currencyDifferenceAccountId: input.currencyDifferenceAccountId }),
      },
      reason,
    });
    return NextResponse.json(run, { status: 201 });
  },
});
