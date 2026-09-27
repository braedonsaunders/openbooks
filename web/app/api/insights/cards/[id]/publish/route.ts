import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { mutateInsight } from "@/lib/insight-mutations";
import { UNTITLED_CARD_NAME } from "@/lib/insight-untitled";
import { validateInsightQuery } from "@openbooks/analytics";
import { isUuid } from "../../../../../../lib/list-params";
import { loadCard } from "../../../_lib";
import { notFound } from "@/lib/api/responses";
const postBodySchema0 = z.strictObject({
  publish: z.boolean().optional(),
  expectedUpdatedAt: z.string().regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/,
    "expectedUpdatedAt must be the exact card revision",
  ),
});

export { runtime } from "@/lib/api/route";

/**
 * A stored card query that no longer validates refuses publish at 422 with
 * the validation message intact. The sanitizer only carries messages on
 * named refusals, so the message rides in one.
 */
class InsightPublishValidationRefusal extends Error {
  readonly status = 422;
  constructor(message: string) {
    super(`The query is incomplete: ${message}`);
    this.name = "InsightPublishValidationRefusal";
  }
}

/**
 * Publish (or unpublish) a card. Publishing gates on insights.publish, requires
 * a real name and a query that compiles — a published card must render for every
 * reader. `{ publish: false }` returns it to draft.
 */
export const POST = defineRoute({
  permission: "insights.publish",
  feature: {
    none: "This insights surface is governed by its permission and has no separate organization feature switch.",
  },
  params: z.object({ id: z.string() }),
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, params, body: routeBody }) => {
    const user = gate.user;
    const { id } = await params;
    if (!isUuid(id))
      return notFound("record");

    const card = await loadCard(id, user.orgId);
    if (!card)
      return notFound("record");

    const body = routeBody;
    const publish = body.publish !== false;

    return mutateInsight(
      gate,
      "insight_cards",
      id,
      "update",
      async (tx, before, revision) => {
        if (
          typeof body.expectedUpdatedAt !== "string" ||
          body.expectedUpdatedAt !== revision
        ) {
          return NextResponse.json(
            {
              error:
                "The record changed; reload and review the latest revision before publishing.",
            },
            { status: 409 },
          );
        }
        const card = before!;
        if (publish) {
          if (
            typeof card.name !== "string" ||
            card.name.trim() === "" ||
            card.name === UNTITLED_CARD_NAME
          ) {
            return NextResponse.json(
              { error: "Give the card a real name before publishing." },
              { status: 422 },
            );
          }
          try {
            validateInsightQuery(card.query);
          } catch (e) {
            return apiErrorResponse(
              e instanceof Error
                ? new InsightPublishValidationRefusal(e.message)
                : e,
            );
          }
        }

        await tx.execute(sql`
    update insight_cards
       set status = ${publish ? "published" : "draft"}, updated_at = greatest(clock_timestamp(), updated_at + interval '1 microsecond'), updated_by = ${user.id}
     where id = ${id} and org_id = ${user.orgId}
  `);

        const updated = await tx.execute(
          sql`select *, to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at from insight_cards where id = ${id} and org_id = ${user.orgId}`,
        );
        return NextResponse.json(updated.rows[0]);
      },
    );
  },
});
