export function DimensionFilter({
  departments, projects, current, extraParams,
}: {
  departments: { id: string; name: string }[];
  projects: { id: string; name: string }[];
  current: { dept?: string; project?: string };
  /** other query params this report needs preserved on submit */
  extraParams: Record<string, string>;
}) {
  return (
    <form method="get" style={{ display: "flex", gap: 10, alignItems: "center", margin: "0 0 16px" }}>
      {Object.entries(extraParams).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <select name="dept" defaultValue={current.dept ?? ""} className="mono"
        style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 7, background: "var(--surface)" }}>
        <option value="">All departments</option>
        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <select name="project" defaultValue={current.project ?? ""} className="mono"
        style={{ padding: "7px 10px", border: "1px solid var(--line)", borderRadius: 7, background: "var(--surface)" }}>
        <option value="">All projects</option>
        {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <button className="btn secondary" type="submit">Apply</button>
    </form>
  );
}
