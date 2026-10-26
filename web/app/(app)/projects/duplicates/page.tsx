import { ModuleView } from "../../../../components/viewspec/module-view";
import { ProjectDuplicatesView } from "./ProjectDuplicatesView";
import { loadProjectDuplicateGroups, projectDuplicateGroupsSpec } from "./view";

export const dynamic = "force-dynamic";

export default async function ProjectDuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const data = await loadProjectDuplicateGroups(sp);
  return (
    <>
      <ModuleView spec={projectDuplicateGroupsSpec(data)} data={data} searchParams={sp} trusted />
      {data.selectedGroup ? (
        <ProjectDuplicatesView
          key={`${data.selectedGroup.kind}:${data.selectedGroup.key}`}
          group={data.selectedGroup}
          canMerge={data.canMerge}
        />
      ) : null}
    </>
  );
}
