export interface CoverageProjectOption {
  value: string
  label: string
}

/** Resolve only an explicit project filter; the All option means no matrix. */
export function selectCoverageProject(
  requestedProjectId: string | undefined,
  projectOptions: readonly CoverageProjectOption[],
): string | null {
  return requestedProjectId && projectOptions.some((project) => project.value === requestedProjectId)
    ? requestedProjectId
    : null
}
