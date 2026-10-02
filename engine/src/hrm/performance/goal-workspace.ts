import { db, withOrgTransaction } from "../../platform/db.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { loadOwnEmploymentIds } from "../authorization.ts";
import { inputGuards } from "../input-guards.ts";
import { HrmPerformanceError } from "./errors.ts";
import { listGoals } from "./performance-read.ts";
import { listOneOnOneDirectory } from "./one-on-ones.ts";
const { requireUuid } = inputGuards(
  (message) => new HrmPerformanceError("INVALID_INPUT", message),
);
/** Compose existing goal authority and the governed employee directory. */
export async function getGoalWorkspace(args: {
  orgId: string;
  actorId: string;
  employmentId?: string;
}) {
  const orgId = requireUuid(args.orgId, "orgId"),
    actorId = requireUuid(args.actorId, "actorId");
  return withOrgTransaction(orgId, async () => {
    const goals = await listGoals(args),
      directory = await listOneOnOneDirectory(args),
      own = new Set(await loadOwnEmploymentIds(db, orgId, actorId));
    const manage = await actorHasPermission(
      db,
      orgId,
      actorId,
      "hrm.performance.manage",
    );
    const employees = directory.employments.map((e) => ({
      value: e.id,
      label: e.name,
      canWrite: manage || own.has(e.id),
    }));
    const names = new Map(employees.map((e) => [e.value, e.label]));
    return {
      employees,
      goals: goals.map((g) => ({
        ...g,
        employee: names.get(g.employmentId) ?? "",
        canWrite: manage || own.has(g.employmentId),
      })),
    };
  });
}
