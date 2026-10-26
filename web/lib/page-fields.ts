/**
 * Describe what a page's loader output offers a layout to bind.
 *
 * A ViewSpec field reference is a dot path and nothing else — `{ "$": "a.b" }`
 * — so "what can I bind here" has an exact, mechanical answer: the dot paths
 * that exist on the data the loader produced. Without it an author writes
 * layouts blind, and a wrong path is invisible: resolution returns `undefined`
 * for a missing field by design, so the page renders with a hole rather than
 * an error. This turns that silent failure into something knowable up front.
 *
 * Arrays get their ITEM shape described separately rather than flattened,
 * because the language treats them differently: a `table` binds the array to
 * `rows` and then resolves its columns against each ROW. Reporting
 * `lines.0.amount` would describe a path no table can use.
 *
 * No `server-only`: this is a pure function over a plain object and its tests
 * run in node.
 */

/** How a value may be bound, phrased in the language's own terms. */
export type FieldType =
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "object"
  | "array"
  /** A rendered React element. Present in the data, but nothing can bind it. */
  | "node"
  /** A function or other value a spec has no way to express. */
  | "unbindable";

export interface FieldDescriptor {
  /** Dot path, relative to the scope this descriptor belongs to. */
  path: string;
  type: FieldType;
  /** For arrays: how many items the loader produced on this run. */
  count?: number;
  /** For arrays: the paths available on each ITEM, relative to the item. */
  item?: FieldDescriptor[];
  /** A short rendering of the value, so an author can see what it holds. */
  sample?: string;
  /** Set when this subtree was cut off by the depth or size budget. */
  truncated?: boolean;
}

export interface FieldCatalog {
  fields: FieldDescriptor[];
  /** True when the budget stopped the walk before it finished. */
  truncated: boolean;
}

const MAX_DEPTH = 4;
const MAX_FIELDS = 600;
const SAMPLE_CHARS = 120;
/** Enough items to see that a row shape is consistent, few enough to stay cheap. */
const ARRAY_PROBE = 3;

function classify(value: unknown): FieldType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    case "undefined":
      return "null";
    case "function":
      return "unbindable";
    case "symbol":
      return "unbindable";
  }
  // A React element is an object, and reporting it as one would invite an
  // author to bind `header.props.children` — a path that resolves to something
  // no block can render. Saying so is the difference between a catalog and a
  // list of properties.
  if (isReactNode(value)) return "node";
  if (value instanceof Date) return "string";
  return "object";
}

function isReactNode(value: object): boolean {
  return "$$typeof" in value && typeof (value as { $$typeof: unknown }).$$typeof === "symbol";
}

function sampleOf(value: unknown, type: FieldType): string | undefined {
  if (type === "object" || type === "array" || type === "node" || type === "unbindable")
    return undefined;
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  const text = typeof value === "string" ? value : String(value);
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}…` : text;
}

/**
 * The paths a spec may bind against this scope.
 *
 * Values are sampled, not just typed. A layout author choosing between
 * `summary.total` and `summary.totalFormatted` needs to see that one is
 * `"12345.67"` and the other `"$12,345.67"`; the type alone says `string` for
 * both. The samples are the caller's OWN data — the loader ran under their
 * permissions and this describes what it returned — so nothing here is visible
 * that reading the page would not already show.
 */
export function describeFields(scope: unknown): FieldCatalog {
  const budget = { remaining: MAX_FIELDS };
  const fields = walk(scope, "", 0, budget);
  return { fields, truncated: budget.remaining <= 0 };
}

function walk(
  scope: unknown,
  prefix: string,
  depth: number,
  budget: { remaining: number },
): FieldDescriptor[] {
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) return [];
  const out: FieldDescriptor[] = [];
  for (const key of Object.keys(scope).sort()) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    // A key that is not a plain identifier cannot be written in a dot path, so
    // it is not bindable and listing it would be a lie.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) continue;
    const value = (scope as Record<string, unknown>)[key];
    const type = classify(value);
    const path = prefix ? `${prefix}.${key}` : key;
    const descriptor: FieldDescriptor = { path, type };
    const sample = sampleOf(value, type);
    if (sample !== undefined) descriptor.sample = sample;

    if (type === "array") {
      const items = value as unknown[];
      descriptor.count = items.length;
      if (depth + 1 > MAX_DEPTH) descriptor.truncated = true;
      else descriptor.item = itemShape(items, depth + 1, budget);
    } else if (type === "object") {
      if (depth + 1 > MAX_DEPTH) descriptor.truncated = true;
      else {
        const children = walk(value, path, depth + 1, budget);
        // A nested object contributes its leaves; the container itself is
        // listed too, because `repeat` and `table` bind containers.
        out.push(descriptor, ...children);
        continue;
      }
    }
    out.push(descriptor);
  }
  return out;
}

/**
 * The shape of an array's items, merged across the first few.
 *
 * Merged rather than read off item 0, because rows are not always uniform —
 * an optional `drillTarget` present on some lines and absent on others is
 * exactly the field an author needs to know about, and item 0 might be the one
 * without it. The item paths are relative, which is how a table's columns
 * resolve them.
 *
 * `depth` is the array's own depth, carried through rather than reset. Reset
 * to zero, a self-referential structure — data that holds a node holding the
 * array again — would descend forever, bounded only by the field budget and
 * emitting nonsense paths on the way.
 */
function itemShape(
  items: unknown[],
  depth: number,
  budget: { remaining: number },
): FieldDescriptor[] {
  const merged = new Map<string, FieldDescriptor>();
  for (const item of items.slice(0, ARRAY_PROBE)) {
    if (budget.remaining <= 0) break;
    for (const field of walk(item, "", depth, budget)) {
      const existing = merged.get(field.path);
      // A path seen as `null` in one row and `string` in another is a string
      // field that is sometimes empty. Keeping the informative type is more
      // useful than keeping whichever row came first.
      if (!existing || existing.type === "null") merged.set(field.path, field);
    }
  }
  return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Every dot path a spec actually binds, so an author can see which parts of
 * the data the built-in layout uses — and, by difference, which it ignores.
 */
export function boundPaths(spec: unknown): string[] {
  const paths = new Set<string>();
  const visit = (node: unknown) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.$ === "string" && Object.keys(record).length === 1) {
      paths.add(record.$);
      return;
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(spec);
  return [...paths].sort();
}

export interface UnresolvedPath {
  /** The dot path exactly as the spec wrote it. */
  path: string;
  /** `page` for the loader root, `row` inside a table row or repeat item. */
  scope: "page" | "row";
  /** The closest path that does exist in that scope, when one is near. */
  suggestion?: string;
}

const ROOT_PREFIX = "$root.";

/**
 * Field references a spec makes that the loader output provably lacks.
 *
 * Scoped the way the renderer resolves them: a table's columns and a repeat's
 * blocks read each ROW (with `$root.` reaching back to the page), everything
 * else reads the page. A path is only reported when the catalog could have
 * seen it — under a truncated subtree, a null value, or an array that produced
 * no rows this run there is nothing to compare against, so nothing is claimed.
 */
export function unresolvedPaths(spec: unknown, catalog: FieldCatalog): UnresolvedPath[] {
  const out = new Map<string, UnresolvedPath>();
  const check = (path: string, scope: FieldDescriptor[] | null, kind: "page" | "row") => {
    if (path.startsWith(ROOT_PREFIX))
      return check(path.slice(ROOT_PREFIX.length), catalog.fields, "page");
    if (scope === null) return;
    if (kind === "page" && catalog.truncated) return;
    if (resolvable(path, scope)) return;
    const key = `${kind}:${path}`;
    if (out.has(key)) return;
    const suggestion = nearestPath(path, scope);
    out.set(key, { path, scope: kind, ...(suggestion ? { suggestion } : {}) });
  };
  const visit = (node: unknown, scope: FieldDescriptor[] | null, kind: "page" | "row") => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, scope, kind);
      return;
    }
    const record = node as Record<string, unknown>;
    if (typeof record.$ === "string" && Object.keys(record).length === 1) {
      check(record.$, scope, kind);
      return;
    }
    const rowsRef =
      record.kind === "table" ? record.rows : record.kind === "repeat" ? record.items : undefined;
    if (
      rowsRef &&
      typeof rowsRef === "object" &&
      typeof (rowsRef as { $?: unknown }).$ === "string"
    ) {
      const rowsPath = (rowsRef as { $: string }).$;
      check(rowsPath, scope, kind);
      const rowScope = itemScope(rowsPath, scope);
      for (const [key, child] of Object.entries(record)) {
        if (key === "rows" || key === "items") continue;
        if (key === "rowKey" || key === "itemKey" || key === "blocks") {
          visit(child, rowScope, "row");
        } else if (key === "columns" && Array.isArray(child)) {
          // A column's header reads the page; its cell reads each row.
          for (const column of child) {
            if (column === null || typeof column !== "object") continue;
            for (const [field, value] of Object.entries(column as Record<string, unknown>)) {
              visit(value, field === "cell" ? rowScope : scope, field === "cell" ? "row" : kind);
            }
          }
        } else {
          visit(child, scope, kind);
        }
      }
      return;
    }
    for (const child of Object.values(record)) visit(child, scope, kind);
  };
  visit(spec, catalog.fields, "page");
  return [...out.values()];
}

function itemScope(path: string, scope: FieldDescriptor[] | null): FieldDescriptor[] | null {
  if (path.startsWith(ROOT_PREFIX) || scope === null) return null;
  const array = scope.find((field) => field.path === path);
  if (!array || array.type !== "array" || !array.item || !array.count) return null;
  return array.item;
}

function resolvable(path: string, scope: FieldDescriptor[]): boolean {
  if (scope.some((field) => field.path === path)) return true;
  // A deeper path under a value the catalog could not open is unknown, not
  // missing: a null today may be an object on another run.
  const segments = path.split(".");
  for (let length = segments.length - 1; length > 0; length--) {
    const parent = scope.find((field) => field.path === segments.slice(0, length).join("."));
    if (!parent) continue;
    return parent.truncated === true || parent.type === "null" || parent.type === "unbindable";
  }
  return false;
}

function nearestPath(path: string, scope: FieldDescriptor[]): string | undefined {
  const target = path.toLowerCase();
  const leaf = target.split(".").pop()!;
  let best: string | undefined;
  let bestScore = Infinity;
  for (const field of scope) {
    const candidate = field.path.toLowerCase();
    const candidateLeaf = candidate.split(".").pop()!;
    const score = Math.min(distance(target, candidate), distance(leaf, candidateLeaf) + 1);
    if (score < bestScore) {
      bestScore = score;
      best = field.path;
    }
  }
  return best !== undefined && bestScore <= Math.max(2, Math.floor(leaf.length / 2))
    ? best
    : undefined;
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

/**
 * A page's built-in spec with its widget props bound to the loader output.
 *
 * Native specs are built from the data they render, so a widget prop holds
 * the RESOLVED value — this request's rows, labels and totals. Copied into an
 * override as-is, those values would freeze: the page would keep showing what
 * the author happened to see. Every top-level widget, frame and header-action
 * prop whose value came from the loader output is replaced by a reference to
 * that path, so the edited layout stays live: a list or object passed through
 * unchanged binds by identity, other values by equality. A primitive found at
 * more than one path is ambiguous and stays literal.
 */
export function bindLiteralProps<T>(spec: T, data: unknown): T {
  const index = new Map<string, string[]>();
  // Structured values the spec passed through unchanged are the SAME object
  // as in the loader output, so identity binds them exactly — including an
  // empty list, which by value would be indistinguishable from any other.
  const identity = new Map<object, string>();
  const record = (value: unknown, path: string, depth: number) => {
    if (depth > MAX_DEPTH + 1 || !path) return;
    if (value && typeof value === "object" && !identity.has(value)) identity.set(value, path);
    if (bindable(value)) {
      const key = stableJson(value);
      const paths = index.get(key) ?? [];
      paths.push(path);
      index.set(key, paths);
    }
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isReactNode(value as object)
    ) {
      for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name))
          record(child, path ? `${path}.${name}` : name, depth + 1);
      }
    }
  };
  if (data && typeof data === "object") {
    for (const [name, child] of Object.entries(data as Record<string, unknown>)) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) record(child, name, 1);
    }
  }
  const bind = (props: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(props).map(([name, value]) => {
        if (value && typeof value === "object" && identity.has(value))
          return [name, { $: identity.get(value)! }];
        if (!bindable(value) || isRef(value)) return [name, value];
        const paths = index.get(stableJson(value));
        if (!paths?.length) return [name, value];
        const structured = typeof value === "object";
        if (!structured && paths.length > 1) {
          // Equal primitives at several paths (two totals both "CA$0") are told
          // apart only when exactly one path is named for the prop.
          const named = paths.filter((path) =>
            path.split(".").pop()!.toLowerCase().includes(name.toLowerCase()),
          );
          return named.length === 1 ? [name, { $: named[0]! }] : [name, value];
        }
        const path = [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b))[0]!;
        return [name, { $: path }];
      }),
    );
  const visit = (node: unknown, inCell: boolean): unknown => {
    if (Array.isArray(node)) return node.map((child) => visit(child, inCell));
    if (!node || typeof node !== "object") return node;
    const source = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(source)) {
      if (
        name === "props" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !inCell &&
        (typeof source.widget === "string" || typeof source.frame === "string")
      ) {
        out[name] = bind(value as Record<string, unknown>);
      } else {
        // Cells resolve against a row, so their literals are left alone.
        out[name] = visit(value, inCell || name === "cell" || name === "inner");
      }
    }
    return out;
  };
  return visit(spec, false) as T;
}

function isRef(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as { $?: unknown }).$ === "string"
  );
}

function bindable(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object")
    return !isReactNode(value) && Object.keys(value).length > 0;
  return false;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, inner) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.keys(inner)
            .sort()
            .map((key) => [key, (inner as Record<string, unknown>)[key]]),
        )
      : inner,
  );
}
