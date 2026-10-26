import { createPlatformNav } from "@braedonsaunders/appkit-superadmin";

type PlatformNavKey =
  | "nav.access"
  | "nav.accessDescription"
  | "nav.overview"
  | "nav.organizations"
  | "nav.users"
  | "nav.feedback"
  | "nav.emailLog"
  | "nav.group"
  | "nav.overviewDescription"
  | "nav.organizationsDescription"
  | "nav.usersDescription"
  | "nav.feedbackDescription"
  | "nav.emailLogDescription"
  | "nav.workspace";

/** OpenBooks operator console: shared AppKit chrome plus acting-user grants. */
export function createOpenBooksPlatformNav(t: (key: PlatformNavKey) => string) {
  return createPlatformNav({
    modules: ["overview", "tenants", "users", "feedback", "emailLog"],
    extras: [
      {
        id: "access",
        href: "/platform/access",
        label: t("nav.access"),
        description: t("nav.accessDescription"),
        iconKey: "key",
      },
    ],
    labels: {
      overview: t("nav.overview"),
      tenants: t("nav.organizations"),
      users: t("nav.users"),
      feedback: t("nav.feedback"),
      emailLog: t("nav.emailLog"),
      group: t("nav.group"),
    },
    descriptions: {
      overview: t("nav.overviewDescription"),
      tenants: t("nav.organizationsDescription"),
      users: t("nav.usersDescription"),
      feedback: t("nav.feedbackDescription"),
      emailLog: t("nav.emailLogDescription"),
    },
    workspaceHref: "/",
    workspaceLabel: t("nav.workspace"),
  });
}

export type PlatformSearch = Record<string, string | string[] | undefined>;

/** Preserve list state while opening or closing a query-addressed drawer. */
export function platformDrawerHref(
  basePath: string,
  params: PlatformSearch,
  selectorKey: string,
  selectorValue?: string,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (key === selectorKey || value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
  }
  if (selectorValue) query.set(selectorKey, selectorValue);
  const search = query.toString();
  return search ? `${basePath}?${search}` : basePath;
}

/** Preserve list state while opening or closing a user detail drawer. */
export function platformUserDrawerHref(
  basePath: string,
  params: PlatformSearch,
  userId?: string,
): string {
  return platformDrawerHref(basePath, params, "user", userId);
}

export function asDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  return value instanceof Date ? value : new Date(value);
}
