"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button, FieldLabel, Select, UrlDrawer } from "@openbooks/ui";
import type { PlatformOrganization, PlatformUser } from "../../../../lib/platform-admin";
import { grantAccessAction } from "../actions";

type UserOption = Pick<PlatformUser, "id" | "name" | "email" | "orgName" | "orgId">;

export function GrantAccessForm({
  members,
  organizations,
  actingUsers,
  open,
  closeHref,
  defaultMemberUserId = "",
}: {
  members: UserOption[];
  organizations: Pick<PlatformOrganization, "id" | "name">[];
  actingUsers: UserOption[];
  open: boolean;
  closeHref: string;
  defaultMemberUserId?: string;
}) {
  const t = useTranslations("platform.access.grant");
  const router = useRouter();
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
        const result = await grantAccessAction(formData);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setOrgId("");
        setActingUserId("");
        if (!defaultMemberUserId) setMemberUserId("");
        toast.success(t("success"));
        router.replace(closeHref);
        router.refresh();
      } catch {
        toast.error(t("requestFailed"));
      }
    });
  }

  return (
    <UrlDrawer
      open={open}
      closeHref={closeHref}
      size="lg"
      title={t("title")}
      description={t("description")}
    >
      <form
        action={submit}
        className="grid gap-4 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] lg:items-end"
      >
        <div className="space-y-1.5">
          <FieldLabel htmlFor="platform-member" help={t("memberHelp")}>
            {t("member")}
          </FieldLabel>
          <Select
            id="platform-member"
            name="memberUserId"
            value={memberUserId}
            onChange={(event) => setMemberUserId(event.target.value)}
            required
            searchable
          >
            <option value="">{t("selectMember")}</option>
            {members.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.email} ({user.orgName})
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="platform-target-org" help={t("organizationHelp")}>
            {t("organization")}
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
            <option value="">{t("selectOrganization")}</option>
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="platform-acting-user" help={t("actingUserHelp")}>
            {t("actingUser")}
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
            <option value="">{t("selectActingUser")}</option>
            {eligibleActingUsers.map((user) => (
              <option key={user.id} value={user.id}>
                {user.name} · {user.email}
              </option>
            ))}
          </Select>
        </div>
        <Button type="submit" disabled={pending || !memberUserId || !orgId || !actingUserId}>
          {pending ? t("granting") : t("submit")}
        </Button>
      </form>
    </UrlDrawer>
  );
}
