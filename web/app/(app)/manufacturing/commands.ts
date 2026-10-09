import type {
  ManufacturingOptions,
  ManufacturingRecordData,
  ManufacturingRow,
  ManufacturingView,
} from "@openbooks/engine/src/manufacturing/workspace.ts";
export type Choice = { value: string; label: string; parentId?: string | null };
export interface Field {
  key: string;
  type?:
    "date" | "decimal" | "integer" | "select" | "boolean" | "text" | "reason";
  required?: boolean;
  nullable?: boolean;
  initial?: unknown;
  options?: Choice[];
  minLength?: number;
}
export interface Command {
  key: string;
  path: string;
  method?: "POST" | "PATCH" | "DELETE" | "PUT";
  fields: Field[];
  body?: Record<string, unknown>;
  create?: boolean;
  opensRecord?: boolean;
  note?: string;
  repeat?: "tracking" | "issue";
  byproducts?: ManufacturingRow[];
}
const field = (
  key: string,
  initial?: unknown,
  extra: Omit<Field, "key" | "initial"> = {},
): Field => ({ key, initial, ...extra });
const select = (
  key: string,
  options: Choice[],
  initial?: unknown,
  required = false,
): Field =>
  field(key, initial, {
    type: "select",
    options,
    required,
    nullable: !required,
  });
const decimal = (key: string, initial?: unknown, required = true): Field =>
  field(key, initial, { type: "decimal", required });
const date = (key: string, initial?: unknown, required = false): Field =>
  field(key, initial, { type: "date", required, nullable: !required });
const reason = (key = "reason", required = true, minLength = 5): Field =>
  field(key, "", { type: "reason", required, minLength, nullable: !required });
const enums = (values: string[]): Choice[] =>
  values.map((value) => ({ value, label: value }));
export function headerCommand(
  view: ManufacturingView,
  options: ManufacturingOptions,
  record?: ManufacturingRow,
): Command {
  const existing = !!record,
    r = record ?? {};
  const fields: Field[] =
    view === "work-orders"
      ? [
          ...(!existing
            ? [
                select("producedItemId", options.items, r.producedItemId, true),
                select(
                  "subsidiaryId",
                  options.subsidiaries,
                  r.subsidiaryId,
                  true,
                ),
                select(
                  "priority",
                  enums(["low", "normal", "high", "rush"]),
                  "normal",
                  true,
                ),
              ]
            : []),
          decimal("quantityOrdered", r.quantityOrdered),
          select("routingId", options.routings, r.routingId),
          select("issueLocationId", options.locations, r.issueLocationId),
          select("receiptLocationId", options.locations, r.receiptLocationId),
          date("plannedStart", r.plannedStart),
          date("plannedEnd", r.plannedEnd),
        ]
      : view === "work-centers"
        ? [
            field("code", r.code, { required: true }),
            field("name", r.name, { required: true }),
            select("subsidiaryId", options.subsidiaries, r.subsidiaryId, true),
            select(
              "kind",
              enums(["machine", "labor", "cell"]),
              r.kind ?? "machine",
              true,
            ),
            decimal("capacityHoursPerDay", r.capacityHoursPerDay ?? "8"),
            decimal("efficiencyPct", r.efficiencyPct ?? "100"),
            select("departmentId", options.departments, r.departmentId),
            select("calendarId", options.calendars, r.calendarId),
            field("absorbsOverhead", r.absorbsOverhead ?? true, {
              type: "boolean",
            }),
          ]
        : view === "routings"
          ? [
              ...(!existing
                ? [
                    select(
                      "producedItemId",
                      options.items,
                      r.producedItemId,
                      true,
                    ),
                  ]
                : []),
              field("code", r.code, { required: true }),
              field("name", r.name, { required: true }),
              date("effectiveFrom", r.effectiveFrom, true),
              date("effectiveTo", r.effectiveTo),
              select(
                "defaultIssueLocationId",
                options.locations,
                r.defaultIssueLocationId,
              ),
              select(
                "defaultReceiptLocationId",
                options.locations,
                r.defaultReceiptLocationId,
              ),
              select(
                "overheadBasis",
                enums(["labor_hours", "machine_hours", "units"]),
                r.overheadBasis ?? "labor_hours",
                true,
              ),
            ]
          : [
              select("subsidiaryId", options.subsidiaries, undefined, true),
              field("horizonDays", "90", { type: "integer", required: true }),
              field("capacityCheck", true, { type: "boolean" }),
            ];
  const path =
    "/api/manufacturing/" +
    (view === "mrp" ? "mrp/runs" : view) +
    (existing ? "/" + r.id : "");
  return {
    key: existing ? "save" : "create",
    path,
    method: existing ? "PATCH" : "POST",
    fields,
    create: !existing,
    opensRecord: !existing,
    note:
      view === "work-orders"
        ? "draftNote"
        : view === "mrp"
          ? "mrpNote"
          : undefined,
  };
}
export function recordCommands(
  view: ManufacturingView,
  data: ManufacturingRecordData,
  options: ManufacturingOptions,
  canPost: boolean,
  canBuy: boolean,
): Command[] {
  const r = data.record,
    base = "/api/manufacturing/" + view + "/" + r.id,
    commands: Command[] = [];
  const push = (
    key: string,
    fields: Field[] = [],
    extra: Partial<Command> = {},
  ) => commands.push({ key, path: base + "/" + key, fields, ...extra });
  if (view === "work-orders") {
    if (r.status === "draft") {
      if (!r.pendingApproval) {
        commands.push(headerCommand(view, options, r));
        push("release", [reason("reason", false, 0)]);
        push("cancel", [reason("reason", false, 0)]);
      }
    }
    if (r.status === "released") push("start");
    if (r.status === "released" || r.status === "in_progress") {
      push("hold", [reason("reason", true, 1)]);
      push("cancel", [reason("reason", false, 0)]);
    }
    if (r.status === "on_hold") push("resume");
    if (canPost && (r.status === "released" || r.status === "in_progress")) {
      push("issue", [], { repeat: "issue", create: true, note: "issueNote" });
      push(
        "complete",
        [
          decimal("quantity"),
          select("receiptLocationId", options.locations, r.receiptLocationId),
        ],
        {
          repeat: "tracking",
          create: true,
          byproducts: data.sections.byproducts,
          note: "outputNote",
        },
      );
      push("done", [reason("shortCloseReason", false)], { note: "doneNote" });
    }
    if (canPost && r.status === "in_progress")
      push(
        "scrap",
        [
          select(
            "operationId",
            (data.sections.operations ?? [])
              .filter((o) => o.status === "running" || o.status === "paused")
              .map((o) => ({
                value: o.id,
                label: String(o.sequence) + " · " + o.name,
              })),
            undefined,
            true,
          ),
          decimal("quantity"),
          select(
            "reasonId",
            options.reasons.filter((x) => x.parentId === "normal"),
            undefined,
            true,
          ),
        ],
        { create: true, note: "normalScrapNote" },
      );
  } else if (view === "work-centers") {
    commands.push(headerCommand(view, options, r));
    push(r.isActive ? "deactivate" : "reactivate", [], {
      path: base,
      method: "PATCH",
      body: { isActive: !r.isActive },
    });
    push(
      "addRate",
      [
        decimal("machineRatePerHour"),
        date("effectiveFrom", undefined, true),
        date("effectiveTo"),
      ],
      { path: base + "/rates", create: true },
    );
  } else if (view === "routings") {
    if (r.status === "draft") {
      commands.push(headerCommand(view, options, r));
      commands.push(operationCommand(String(r.id), options));
      push("activate", [], { note: "activateNote" });
    }
    if (r.status === "active") push("archive");
    push("newVersion", [], {
      path: base + "/versions",
      create: true,
      opensRecord: true,
      note: "versionNote",
    });
  }
  return commands;
}
export function operationCommand(
  routingId: string,
  options: ManufacturingOptions,
  op?: ManufacturingRow,
): Command {
  const r = op ?? {};
  return {
    key: op ? "editOperation" : "addOperation",
    path:
      "/api/manufacturing/routings/" +
      routingId +
      "/operations" +
      (op ? "/" + op.id : ""),
    method: op ? "PATCH" : "POST",
    create: !op,
    fields: [
      field("sequence", r.sequence, { type: "integer", required: true }),
      field("name", r.name, { required: true }),
      select("workCenterId", options.centers, r.workCenterId, true),
      decimal("setupMinutes", r.setupMinutes ?? "0"),
      decimal("runMinutesPerUnit", r.runMinutesPerUnit ?? "0"),
      decimal("laborMinutesPerUnit", r.laborMinutesPerUnit, false),
      select(
        "backflushAt",
        enums(["none", "start", "finish"]),
        r.backflushAt ?? "none",
        true,
      ),
      select(
        "qualityGate",
        enums(["none", "measure"]),
        r.qualityGate ?? "none",
        true,
      ),
    ],
  };
}
export function childCommands(
  view: ManufacturingView,
  tab: string,
  r: ManufacturingRow,
  row: ManufacturingRow,
  options: ManufacturingOptions,
  canPost: boolean,
  canBuy: boolean,
): Command[] {
  if (
    view === "work-orders" &&
    canPost &&
    r.status === "in_progress" &&
    tab === "operations"
  ) {
    const base =
      "/api/manufacturing/work-orders/" + r.id + "/operations/" + row.id;
    if (row.status === "pending")
      return [{ key: "startOperation", path: base + "/start", fields: [] }];
    if (row.status === "paused")
      return [{ key: "resumeOperation", path: base + "/resume", fields: [] }];
    if (row.status === "running")
      return [
        {
          key: "pauseOperation",
          path: base + "/pause",
          fields: [reason("reason", true, 1)],
        },
        {
          key: "completeOperation",
          path: base + "/complete",
          note: "operationNote",
          fields: [
            decimal("doneQty", row.quantityPlanned),
            decimal(
              "measuredQty",
              row.measuredQty,
              row.qualityGate === "measure",
            ),
            decimal("actualSetupMinutes", row.actualSetupMinutes, false),
            decimal("actualRunMinutes", row.actualRunMinutes, false),
            decimal("actualLaborMinutes", row.actualLaborMinutes, false),
          ],
        },
      ];
  }
  if (
    view === "work-orders" &&
    canPost &&
    tab === "materials" &&
    ["released", "in_progress"].includes(String(r.status)) &&
    !row.waiveReason
  )
    return [
      {
        key: "waive",
        path:
          "/api/manufacturing/work-orders/" +
          r.id +
          "/materials/" +
          row.id +
          "/waive",
        fields: [reason()],
      },
    ];
  if (view === "work-centers" && tab === "rates" && !row.effectiveTo)
    return [
      {
        key: "endRate",
        path: "/api/manufacturing/work-centers/" + r.id + "/rates/" + row.id,
        method: "PATCH",
        fields: [date("effectiveTo", undefined, true)],
      },
    ];
  if (view === "routings" && r.status === "draft" && tab === "operations")
    return [
      operationCommand(r.id, options, row),
      {
        key: "deleteOperation",
        path: "/api/manufacturing/routings/" + r.id + "/operations/" + row.id,
        method: "DELETE",
        fields: [],
        note: "deleteOperationNote",
      },
    ];
  if (view === "mrp" && r.status === "complete" && tab === "suggestions") {
    const base = "/api/manufacturing/mrp/planned-orders/" + row.id;
    const result: Command[] = [];
    if (row.status === "suggested")
      result.push({ key: "confirm", path: base + "/confirm", fields: [] });
    if (row.status === "confirmed" && (row.action !== "buy" || canBuy))
      result.push({
        key: "convert",
        path: base + "/convert",
        note: "convertNote",
        fields:
          row.action === "buy"
            ? [select("vendorId", options.vendors, undefined, true)]
            : row.action === "transfer"
              ? [
                  select("fromLocationId", options.locations, undefined, true),
                  select("toLocationId", options.locations, undefined, true),
                ]
              : [],
      });
    if (row.status === "suggested" || row.status === "confirmed")
      result.push({
        key: "dismiss",
        path: base + "/dismiss",
        fields: [reason("reason", true, 1)],
      });
    return result;
  }
  return [];
}
export function commandBody(
  command: Command,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const body: Record<string, unknown> = { ...command.body };
  for (const f of command.fields) {
    const value = values[f.key];
    if (f.type === "boolean") body[f.key] = value === true;
    else if (value === undefined || value === "") {
      if (f.nullable) body[f.key] = null;
    } else body[f.key] = f.type === "integer" ? Number(value) : value;
  }
  return body;
}
