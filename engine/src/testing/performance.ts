import { db, withOrgTransaction } from "../platform/db.ts";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import {
  createCalibrationSession,
  openCalibrationSession,
  setCalibratedRating,
  closeCalibrationSession,
} from "../hrm/performance/calibration.ts";
import { getReviewDetail } from "../hrm/performance/performance-read.ts";
import { HrmPerformanceError } from "../hrm/performance/errors.ts";
import { assertFixtureDatabase } from "./fixtures.ts";

/** Review privacy and scope fixtures publish a real, tenant-governed calibration session. */
export async function calibrateReviewFixture(args: {
  orgId: string;
  actorId: string;
  reviewId: string;
  calibratedRating: string;
  reason: string;
}) {
  await assertFixtureDatabase();
  installEngineSeams();
  return withOrgTransaction(args.orgId, async () => {
    const review = (await getReviewDetail(args)).review;
    const session = await createCalibrationSession({
      ...args,
      cycleId: review.cycleId,
      name: "Review calibration",
    });
    const opened = await openCalibrationSession({ ...args, id: session.id });
    const entry = opened.entries.find((entry) => entry.reviewId === args.reviewId);
    if (!entry)
      throw new HrmPerformanceError(
        "NOT_FOUND",
        "The submitted review is unavailable for this calibration.",
      );
    await setCalibratedRating({ ...args, entryId: entry.id, justification: args.reason });
    const closed = await closeCalibrationSession({ ...args, id: session.id });
    if (closed.approvalPending)
      throw new Error("The calibration fixture must complete its configured Flow gates.");
    const event = await db.execute(
      sql`select id from hrm_calibration_events where org_id=${args.orgId} and session_id=${session.id}`,
      "objects",
    );
    if (!event.length) throw new Error("Native calibration publication did not retain its events.");
    return (await getReviewDetail(args)).review;
  });
}
