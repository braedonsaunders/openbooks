"use client";

import { useMemo, useState, useTransition } from "react";
import { Badge, Button, Card, Select } from "@openbooks/ui";
import { enterOrg } from "../../../../lib/sandbox-session";
import type { SuperGrant, SuperOrg, SuperUser } from "../../../../lib/super-admin";
import {
  grantAccessAction,
  revokeAccessAction,
  setSuperAdminAction,
} from "./actions";

export function SuperAdminConsole({
  orgs,
  users,
  grants,
}: {
  orgs: SuperOrg[];
  users: SuperUser[];
  grants: SuperGrant[];
}) {
  const [pending, start] = useTransition();
  const prodOrgs = orgs.filter((o) => o.envKind === "production");

  return (
    <div className="space-y-8">
      {/* Organizations */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Organizations ({orgs.length})
        </h2>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {orgs.map((o) => (
            <Card key={o.id} className="flex items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
                    {o.name}
                  </span>
                  <Badge variant={o.envKind === "production" ? "secondary" : "warning"}>
                    {o.envKind}
                  </Badge>
                </div>
                <div className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                  {o.userCount} users
                  {o.envKind === "production" && ` · ${o.sandboxCount} sandboxes`}
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => start(async () => void (await enterOrg(o.id)))}
              >
                Enter
              </Button>
            </Card>
          ))}
        </div>
      </section>

      {/* Super admins */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Users &amp; super admin
        </h2>
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {users.map((u) => (
            <div key={u.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0">
                <div className="truncate text-sm text-slate-900 dark:text-slate-100">
                  {u.name || u.email}
                  {u.isSuperAdmin && (
                    <Badge variant="warning" className="ml-2 text-[10px]">
                      super admin
                    </Badge>
                  )}
                </div>
                <div className="truncate text-xs text-slate-500 dark:text-slate-400">
                  {u.email} · {u.orgName} · {u.role}
                </div>
              </div>
              <Button
                size="sm"
                variant={u.isSuperAdmin ? "destructive" : "outline"}
                disabled={pending}
                onClick={() => start(async () => void (await setSuperAdminAction(u.id, !u.isSuperAdmin)))}
              >
                {u.isSuperAdmin ? "Revoke" : "Make super admin"}
              </Button>
            </div>
          ))}
        </Card>
      </section>

      {/* Cross-tenant access grants */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
          Cross-tenant access
        </h2>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Grant a login identity access to another production org, acting as a user there. Super
          admins already reach every org.
        </p>
        <GrantForm users={users} prodOrgs={prodOrgs} pending={pending} start={start} />
        <Card className="divide-y divide-slate-100 dark:divide-slate-800">
          {grants.length === 0 && (
            <div className="p-3 text-sm text-slate-500 dark:text-slate-400">No grants yet.</div>
          )}
          {grants.map((g) => (
            <div key={g.id} className="flex items-center justify-between gap-3 p-3">
              <div className="min-w-0 text-sm text-slate-700 dark:text-slate-200">
                <span className="font-medium">{g.memberEmail}</span>
                <span className="text-slate-400"> ({g.memberOrgName})</span> → {g.orgName}
                <span className="text-slate-400"> as {g.actingEmail}</span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => start(async () => void (await revokeAccessAction(g.id)))}
              >
                Revoke
              </Button>
            </div>
          ))}
        </Card>
      </section>
    </div>
  );
}

function GrantForm({
  users,
  prodOrgs,
  pending,
  start,
}: {
  users: SuperUser[];
  prodOrgs: SuperOrg[];
  pending: boolean;
  start: (fn: () => Promise<void>) => void;
}) {
  const [memberUserId, setMember] = useState("");
  const [orgId, setOrg] = useState("");
  const [actingUserId, setActing] = useState("");
  const actingOptions = useMemo(() => users.filter((u) => u.orgId === orgId), [users, orgId]);

  return (
    <Card className="flex flex-wrap items-end gap-3 p-3">
      <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
        Member (login)
        <Select value={memberUserId} onChange={(e) => setMember(e.target.value)} className="w-56">
          <option value="">Select user…</option>
          {users.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email} ({u.orgName})
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
        Target org
        <Select
          value={orgId}
          onChange={(e) => {
            setOrg(e.target.value);
            setActing("");
          }}
          className="w-48"
        >
          <option value="">Select org…</option>
          {prodOrgs.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
        Acts as
        <Select
          value={actingUserId}
          onChange={(e) => setActing(e.target.value)}
          className="w-56"
          disabled={!orgId}
        >
          <option value="">Select user…</option>
          {actingOptions.map((u) => (
            <option key={u.id} value={u.id}>
              {u.email}
            </option>
          ))}
        </Select>
      </label>
      <Button
        disabled={pending || !memberUserId || !orgId || !actingUserId}
        onClick={() =>
          start(async () => {
            await grantAccessAction({ memberUserId, orgId, actingUserId });
            setMember("");
            setOrg("");
            setActing("");
          })
        }
      >
        Grant access
      </Button>
    </Card>
  );
}
