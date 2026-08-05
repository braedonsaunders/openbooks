"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button, Card, FieldLabel, Select } from "@openbooks/ui";
import type {
  PlatformOrganization,
  PlatformUser,
} from "../../../../lib/platform-admin";
import { grantAccessAction } from "../actions";

type UserOption = Pick<
  PlatformUser,
  "id" | "name" | "email" | "orgName" | "orgId"
>;

export function GrantAccessForm({
  members,
  organizations,
  actingUsers,
  defaultMemberUserId = "",
}: {
  members: UserOption[];
  organizations: Pick<PlatformOrganization, "id" | "name">[];
  actingUsers: UserOption[];
  defaultMemberUserId?: string;
}) {
  const [memberUserId, setMemberUserId] = useState(defaultMemberUserId);
  const [orgId, setOrgId] = useState("");
  const [actingUserId, setActingUserId] = useState("");
  const [pending, startTransition] = useTransition();
  const eligibleActingUsers = useMemo(
    () => actingUsers.filter((user) => user.orgId === orgId),
    [actingUsers, orgId],
  );

  function submit(formData: FormData) {
    startTransition(async () => {
      try {
        await grantAccessAction(formData);
        setOrgId("");
        setActingUserId("");
        if (!defaultMemberUserId) setMemberUserId("");
        toast.success("Cross-organization access granted");
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "Access could not be granted",
        );
      }
    });
  }

  return (
    <Card className="p-4">
      <form
        action={submit}
        className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] lg:items-end"
      >
        <div className="space-y-1.5">
          <FieldLabel
            htmlFor="platform-member"
            help="The person's home login identity. This remains the accountable member when they enter another organization."
          >
            Member identity
          </FieldLabel>
          <Select
            id="platform-member"
            name="memberUserId"
            value={memberUserId}
            onChange={(event) => setMemberUserId(event.target.value)}
            required
            searchable
          >
            <option value="">Select a member…</option>
            {members.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.email} ({user.orgName})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <FieldLabel
            htmlFor="platform-target-org"
            help="The production organization the member will be allowed to enter. Home-organization access is already implicit."
          >
            Target organization
          </FieldLabel>
          <Select
            id="platform-target-org"
            name="orgId"
            value={orgId}
            onChange={(event) => {
              setOrgId(event.target.value);
              setActingUserId("");
            }}
            required
            searchable
          >
            <option value="">Select an organization…</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <FieldLabel
            htmlFor="platform-acting-user"
            help="The active user record whose roles and permissions apply while the member is operating in the target organization."
          >
            Acts as
          </FieldLabel>
          <Select
            id="platform-acting-user"
            name="actingUserId"
            value={actingUserId}
            onChange={(event) => setActingUserId(event.target.value)}
            disabled={!orgId}
            required
            searchable
          >
            <option value="">Select an acting user…</option>
            {eligibleActingUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.email}
              </option>
            ))}
          </Select>
        </div>
        <Button
          type="submit"
          disabled={pending || !memberUserId || !orgId || !actingUserId}
        >
          {pending ? "Granting…" : "Grant access"}
        </Button>
      </form>
    </Card>
  );
}
