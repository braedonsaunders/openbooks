import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { seedFlowActors, type ScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

type SetupSession = { gate: { user: { orgId: string; id: string } } | null };
type Method = "POST" | "PATCH" | "DELETE";
type Handler = (request: Request, context: { params: Promise<{ entity: string }> }) => Promise<Response>;

export async function seedSetupActor(org: ScratchOrg, state: SetupSession): Promise<string> {
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  state.gate = { user: { orgId: org.orgId, id: actorId } };
  const updated = await db.execute(sql`update orgs set settings=jsonb_set(coalesce(settings,'{}'::jsonb),'{features}',coalesce(settings->'features','{}'::jsonb)||'{"multiSubsidiary":true}'::jsonb) where id=${org.orgId} returning id`);
  if (updated.rows.length !== 1) throw new Error("Setup fixture organization was not updated");
  return actorId;
}

export function setupWriteSender(handlers: Record<Method, Handler>) {
  return (method: Method, entity: string, body: Record<string, unknown>) => {
    const request = new Request(`http://audit.local/api/admin/setup/${entity}${method === "DELETE" ? "?id=" + body.id : ""}`, {
      method, headers: { "Content-Type": "application/json", ...(method === "POST" ? { "Idempotency-Key": randomUUID() } : {}) },
      ...(method === "DELETE" ? {} : { body: JSON.stringify(body) }),
    });
    return handlers[method](request, { params: Promise.resolve({ entity }) });
  };
}
