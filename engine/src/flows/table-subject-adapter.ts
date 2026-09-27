import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { BUILT_IN_ROLE_NAMES } from "./subject-profiles.ts";
import type { FlowSubjectAdapter } from "./types.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type TableSubjectAdapterDefinition = Omit<FlowSubjectAdapter, "profile" | "writableFields"> & {
  profile: FlowSubjectProfile;
  writableFields?: Iterable<string>;
};

export function isTableSubjectId(subjectId: string): boolean {
  return UUID_RE.test(subjectId);
}

/** Apply shared roles and status options plus UUID checks to table-backed flow reads. */
export function defineTableSubjectAdapter(definition: TableSubjectAdapterDefinition): FlowSubjectAdapter {
  const statuses = definition.profile.statuses.map((status) => ({ ...status }));
  const fields = definition.profile.fields.map((field) =>
    field.key === "status" && field.type === "enum" && !field.options
      ? { ...field, options: statuses.map((status) => ({ ...status })) }
      : { ...field },
  );
  const profile: FlowSubjectProfile = {
    ...definition.profile,
    roles: [...BUILT_IN_ROLE_NAMES],
    statuses,
    fields,
  };
  return {
    ...definition,
    profile,
    writableFields: new Set(definition.writableFields ?? []),
    async loadContext(subjectId) {
      if (!isTableSubjectId(subjectId)) return null;
      return definition.loadContext(subjectId);
    },
    async getStatus(subjectId) {
      if (!isTableSubjectId(subjectId)) return null;
      return definition.getStatus(subjectId);
    },
  };
}
