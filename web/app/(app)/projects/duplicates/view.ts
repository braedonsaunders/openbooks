import "server-only";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  badge,
  column,
  field,
  link,
  page,
  pageHeader,
  ref,
  text,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { findDuplicateProjects, type DuplicateGroup } from "@openbooks/engine/projects/merge";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import { can, requirePermission } from "../../../../lib/authz";
import { requireProjectsFeature } from "../../../../lib/projects-gate";
import { pickString } from "../../../../lib/list-params";

export interface ProjectDuplicateGroupsData {
  title: string;
  description: string;
  backLabel: string;
  emptyTitle: string;
  columns: { kind: string; key: string; candidates: string; survivor: string; open: string };
  groups: {
    id: string;
    kindLabel: string;
    key: string;
    candidateCount: string;
    survivor: string;
    href: string;
    openLabel: string;
  }[];
  selectedGroup: DuplicateGroup | null;
  canMerge: boolean;
}

const groupId = (group: Pick<DuplicateGroup, "kind" | "key">) => `${group.kind}:${group.key}`;

export async function loadProjectDuplicateGroups(
  sp: Record<string, string | string[] | undefined>,
): Promise<ProjectDuplicateGroupsData> {
  const authz = await requirePermission("projects.read");
  await requireProjectsFeature(authz.user.orgId);
  const [t, projects] = await Promise.all([
    getTranslations("projects"),
    findDuplicateProjects(authz.user.orgId, {
      subsidiaryIds: authz.allowedSubsidiaryIds === null ? null : [...authz.allowedSubsidiaryIds],
    }),
  ]);
  const rows = projects
    .map((group) => {
      const survivor = group.projects[0];
      if (!survivor) return null;
      return {
        id: groupId(group),
        kindLabel: t(`duplicates.kind.${group.kind}`, { key: group.key }),
        key: group.key,
        candidateCount: String(group.projects.length),
        survivor: survivor.code ? `${survivor.name} · ${survivor.code}` : survivor.name,
        href: `/projects/duplicates?group=${encodeURIComponent(groupId(group))}`,
        openLabel: t("duplicates.openGroup"),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  const selected = pickString(sp.group);
  const selectedGroup = selected
    ? (projects.find((group) => groupId(group) === selected) ?? null)
    : null;
  if (selected && !selectedGroup) notFound();

  return {
    title: t("duplicates.title"),
    description: t("duplicates.description"),
    backLabel: t("list.title"),
    emptyTitle: t("duplicates.empty"),
    columns: {
      kind: t("duplicates.matchKind"),
      key: t("duplicates.matchKey"),
      candidates: t("duplicates.candidateCount"),
      survivor: t("duplicates.survivor"),
      open: t("duplicates.openGroup"),
    },
    groups: rows,
    selectedGroup,
    canMerge: can(authz, "projects.manage"),
  };
}

const f = ref<ProjectDuplicateGroupsData>();
const row = field;

export function projectDuplicateGroupsSpec(_data: ProjectDuplicateGroupsData): PageSpec {
  return page({
    route: "/projects/duplicates",
    layout: "list",
    header: [
      pageHeader({
        title: f("title"),
        description: f("description"),
        back: { href: "/projects", label: f("backLabel") },
      }),
    ],
    body: [
      registeredListTable("projects_duplicate_groups", {
        variant: "app",
        rows: f("groups"),
        rowKey: row("id"),
        columns: [
          column(f("columns.kind"), text(row("kindLabel"))),
          column(f("columns.key"), text(row("key"), { className: "font-mono" })),
          column(f("columns.candidates"), badge(row("candidateCount"), { variant: "secondary" })),
          column(f("columns.survivor"), text(row("survivor"))),
          column("", link(row("openLabel"), row("href"))),
        ],
        empty: { title: f("emptyTitle") },
      }),
    ],
  });
}
