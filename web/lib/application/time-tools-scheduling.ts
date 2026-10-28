import "server-only";
import { z } from "zod";
import { richTextDocumentSchema, schedulePdfLayoutSchema } from "@openbooks/forms-core";
import { can } from "../authz";
import { assertApplicationPermission, type ApplicationContext } from "./context";
import { type ApplicationToolDefinition } from "./tool-definition";
import { timeDefinition } from "./time-tool-common";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { getBoard, listBoards, boardAuthority } from "@openbooks/engine/schedule-boards/boards";
import {
  createAssignment,
  listBoardAssignments,
  listBoardPatterns,
  closeAssignment,
  generateAssignment,
  recordPatternException,
  revokePatternException,
} from "@openbooks/engine/schedule-boards/pattern-store";
import { applyBoardChanges, type BoardChange } from "@openbooks/engine/schedule-boards/entries";
import { publishScheduleBoard } from "@openbooks/engine/schedule-boards/publications";
import { closeShift, processBoardAttendance } from "@openbooks/engine/schedule-boards/attendance";
import { deliverScheduleNotices } from "../scheduling/notify";
import { sendScheduleDistribution } from "@openbooks/engine/schedule-boards/distribution";
import { loadBoardWindow } from "@openbooks/engine/schedule-boards/window";
import { actor, DATE, IDEMPOTENCY_KEY, settleTimeRefusal, UUID } from "./time-tool-common";

const boardPermissions = [
  "hrm.shifts.manage",
  "service.dispatch",
  "projects.manage",
  "assets.manage",
] as const;
const boardReadPermissions = [
  ...boardPermissions,
  "hrm.shifts.read",
  "service.read",
  "projects.read",
  "assets.read",
] as const;
const BOARD_ID = UUID.describe("Scheduling board id from list_schedule_boards.");
const ENTRY_ID = UUID.describe("Schedule entry id from list_schedule_board_assignments.");
const SCHEDULE_DATE = DATE;

function canManageBoard(authz: ApplicationContext["authz"]): boolean {
  return boardPermissions.some((permission) => can(authz, permission));
}

async function requireBoard(
  context: ApplicationContext,
  boardId: string,
  mode: "read" | "manage" | "publish",
) {
  return withOrgTransaction(context.authz.user.orgId, async () => {
    const nativeActor = actor(context);
    const board = await getBoard(nativeActor, boardId);
    await boardAuthority(nativeActor, board, mode);
    return board;
  }).catch((error: unknown) => settleTimeRefusal(error));
}

const dateSpan = z.object({
  from: SCHEDULE_DATE.describe("First schedule date, inclusive."),
  through: SCHEDULE_DATE.describe("Last schedule date, inclusive."),
});

const span = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("day").describe("All day booking.") }).strict(),
  z
    .object({
      mode: z.literal("timed").describe("Booking with local clock times."),
      starts: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .describe("Local start time in HH:MM."),
      ends: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .describe("Local end time in HH:MM."),
      breakMinutes: z.number().int().min(0).max(240).describe("Unpaid break minutes."),
    })
    .strict(),
]);
const target = z
  .object({
    kind: z.enum(["customer", "project", "location", "code"]).describe("Target kind."),
    id: UUID.describe("Target id from the board's native pickers."),
  })
  .strict()
  .nullable()
  .describe("Customer, project, location or schedule code for the booking.");
const createFields = {
  workerPartyId: UUID.optional().describe("Person assigned to the booking."),
  subject: z
    .object({
      kind: z.enum(["person", "equipment", "location"]).describe("Booked resource kind."),
      id: UUID.describe("Person or resource id."),
    })
    .strict()
    .optional()
    .describe("Resource booking subject when workerPartyId is not supplied."),
  onDate: SCHEDULE_DATE.describe("Date the booking begins."),
  target,
  projectTaskId: UUID.nullable().optional().describe("Project task associated with the booking."),
  departmentId: UUID.nullable().optional().describe("Department associated with the booking."),
  detail: z.string().max(120).nullable().optional().describe("Short booking detail."),
  notes: z.string().max(2000).nullable().optional().describe("Booking notes."),
  span: span.describe("All day or timed booking duration."),
  seriesId: UUID.nullable().optional().describe("Recurring series id, when applicable."),
};

const audience = z
  .object({
    visibility: z.enum(["personal", "board"]).describe("Personal recipient list or whole board."),
    recipientMode: z
      .enum(["automatic", "selected", "combined"])
      .optional()
      .describe("How recipients are selected."),
    everyone: z.boolean().describe("Include everyone in the selected audience."),
    subjectIds: z.array(UUID).max(500).describe("Selected worker or resource ids."),
    cohort: z
      .enum(["scope", "scheduled", "supervisors", "self"])
      .optional()
      .describe("Automatic audience cohort."),
    additionalRoleKeys: z
      .array(z.string().min(1).max(80))
      .max(20)
      .optional()
      .describe("Additional role keys to include."),
    additionalPartyIds: z
      .array(UUID)
      .max(500)
      .optional()
      .describe("Additional party ids to include."),
    pdfLayout: schedulePdfLayoutSchema
      .nullable()
      .optional()
      .describe("Optional reviewed schedule PDF layout."),
    includePdf: z.boolean().optional().describe("Attach the schedule PDF to the distribution."),
    message: z.string().max(4000).optional().describe("Plain-text message to recipients."),
    messageContent: richTextDocumentSchema.optional().describe("Rich-text message content."),
  })
  .strict()
  .describe("Recipients, message and optional PDF settings for a schedule distribution.");

export const SCHEDULING_APPLICATION_TOOLS: ApplicationToolDefinition[] = [
  timeDefinition({
    name: "list_schedule_boards",
    title: "List Schedule Boards",
    description:
      "List active schedule boards visible in the current legal-entity scope. Use the returned board id with schedule assignment and attendance commands.",
    inputSchema: z.object({
      includeArchived: z.boolean().optional().describe("Include archived boards."),
      generalOnly: z.boolean().optional().describe("Restrict to general, non-project boards."),
      projectId: UUID.optional().describe("Restrict to one project."),
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => boardReadPermissions.some((permission) => can(authz, permission)),
    execute: async (context, input) => {
      const rows = await listBoards(actor(context), input);
      return { ok: true, boards: rows, href: "/scheduling/boards" };
    },
  }),
  timeDefinition({
    name: "list_schedule_board_assignments",
    title: "List Schedule Board Assignments",
    description:
      "Read recurring assignments and available patterns for a schedule board. Find the board with `list_schedule_boards`; this is the native source for assignment and exception ids.",
    inputSchema: z.object({ boardId: BOARD_ID }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => boardReadPermissions.some((permission) => can(authz, permission)),
    execute: async (context, input) => {
      try {
        await requireBoard(context, input.boardId, "read");
        const nativeActor = { ...actor(context), boardId: input.boardId };
        const [assignments, patterns] = await Promise.all([
          listBoardAssignments(nativeActor),
          listBoardPatterns(nativeActor),
        ]);
        return { ok: true, assignments, patterns, href: "/scheduling/boards" };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "get_schedule_board_window",
    title: "Get Schedule Board Window",
    description:
      "Read people and resource bookings, revisions, attendance and publication state for a board date range. Find the board with `list_schedule_boards`; use entry ids and revisions from this result for booking changes or shift close.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      ...dateSpan.shape,
    }),
    readOnly: true,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "never",
    visibleTo: (authz) => boardReadPermissions.some((permission) => can(authz, permission)),
    execute: async (context, input) => {
      try {
        const window = await loadBoardWindow({
          ...actor(context),
          boardId: input.boardId,
          from: input.from,
          through: input.through,
        });
        return { ok: true, ...window, href: "/scheduling/boards" };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "create_schedule_pattern_assignment",
    title: "Create Schedule Pattern Assignment",
    description:
      "Assign a setup pattern to a person and generate its initial booking horizon. The pattern and worker ids come from `list_schedule_board_assignments`; pass a new UUID as assignmentId for idempotent creation.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      assignmentId: UUID.describe(
        "New assignment UUID; the native route uses this as its creation key.",
      ),
      patternId: UUID.describe("Active pattern id from list_schedule_board_assignments."),
      workerPartyId: UUID.describe("Worker party id from the board."),
      employmentId: UUID.nullable()
        .optional()
        .describe("Employment record for the worker, if known."),
      effectiveFrom: SCHEDULE_DATE.describe("First date this pattern applies."),
      effectiveTo: SCHEDULE_DATE.nullable().describe(
        "Last date this pattern applies, or null for no end date.",
      ),
      reason: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .describe("Reason for assigning the recurring pattern."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "hrm.shifts.manage"),
    featureKey: "hrmShiftPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "hrm.shifts.manage");
      try {
        const { idempotencyKey: _key, boardId, assignmentId, ...rest } = input;
        const result = await createAssignment({
          ...actor(context),
          boardId,
          id: assignmentId,
          ...rest,
        });
        return {
          ok: true,
          assignmentId: result.assignment.id,
          status: result.assignment.status,
          assignment: result.assignment,
          generation: result.generation,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "update_schedule_pattern_assignment",
    title: "Update Schedule Pattern Assignment",
    description:
      "End or cancel a recurring pattern assignment and reconcile its future generated bookings. Find the current revision with `list_schedule_board_assignments`.",
    inputSchema: z.object({
      assignmentId: UUID.describe("Pattern assignment id from list_schedule_board_assignments."),
      action: z.enum(["end", "cancel"]).describe("End on a date or cancel the assignment."),
      expectedRevision: z
        .number()
        .int()
        .positive()
        .describe("Current assignment revision from list_schedule_board_assignments."),
      effectiveTo: SCHEDULE_DATE.optional().describe(
        "Last date worked; required when action is end.",
      ),
      reason: z.string().trim().min(1).max(2000).describe("Reason for ending or cancelling."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "hrm.shifts.manage"),
    featureKey: "hrmShiftPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "hrm.shifts.manage");
      try {
        const { idempotencyKey: _key, assignmentId, ...rest } = input;
        const result = await closeAssignment({ ...actor(context), assignmentId, ...rest });
        return {
          ok: true,
          assignmentId,
          status: result.assignment.status,
          assignment: result.assignment,
          generation: result.generation,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "generate_schedule_assignment",
    title: "Generate Schedule Assignment",
    description:
      "Reconcile the future bookings generated by a recurring assignment through a date or its pattern horizon. Find the assignment with `list_schedule_board_assignments`.",
    inputSchema: z.object({
      assignmentId: UUID.describe("Pattern assignment id from list_schedule_board_assignments."),
      through: SCHEDULE_DATE.nullable()
        .optional()
        .describe("Last date to generate through; null uses the configured horizon."),
      reason: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Reason recorded for the generation."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "hrm.shifts.manage"),
    featureKey: "hrmShiftPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "hrm.shifts.manage");
      try {
        const result = await generateAssignment({
          ...actor(context),
          assignmentId: input.assignmentId,
          through: input.through,
          reason: input.reason,
        });
        return {
          ok: true,
          assignmentId: input.assignmentId,
          status: "generated",
          generation: result,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "record_schedule_pattern_exception",
    title: "Record Schedule Pattern Exception",
    description:
      "Omit one generated occurrence or select its real repeated clock-time instants during a daylight-saving transition. Find the assignment with `list_schedule_board_assignments`.",
    inputSchema: z
      .object({
        assignmentId: UUID.describe("Pattern assignment id."),
        kind: z
          .enum(["omit", "select_instant"])
          .describe("Omit the occurrence or select its repeated clock-time instants."),
        occursOn: SCHEDULE_DATE.describe("Occurrence date."),
        slotIndex: z.number().int().min(0).max(999).describe("Zero-based pattern slot index."),
        startsAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          .optional()
          .describe("Selected UTC start instant for a repeated clock time."),
        endsAt: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
          .optional()
          .describe("Selected UTC end instant for a repeated clock time."),
        reason: z.string().trim().min(1).max(2000).describe("Reason for the exception."),
        idempotencyKey: IDEMPOTENCY_KEY,
      })
      .strict()
      .superRefine((input, ctx) => {
        if (input.kind === "select_instant" && (!input.startsAt || !input.endsAt)) {
          ctx.addIssue({
            code: "custom",
            path: ["startsAt"],
            message: "Select both UTC instants for the repeated clock time.",
          });
        }
        if (input.kind === "omit" && (input.startsAt || input.endsAt)) {
          ctx.addIssue({
            code: "custom",
            path: ["startsAt"],
            message: "Omit exceptions do not take selected instants.",
          });
        }
      }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "hrm.shifts.manage"),
    featureKey: "hrmShiftPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "hrm.shifts.manage");
      try {
        const { idempotencyKey: _key, assignmentId, ...rest } = input;
        const result = await recordPatternException({ ...actor(context), assignmentId, ...rest });
        return {
          ok: true,
          assignmentId,
          status: "exception_recorded",
          assignment: result.assignment,
          generation: result.generation,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "revoke_schedule_pattern_exception",
    title: "Revoke Schedule Pattern Exception",
    description:
      "Revoke an occurrence exception so the pattern can generate that occurrence again. Use the exception id from the setup record list and verify on its schedule board.",
    inputSchema: z.object({
      exceptionId: UUID.describe("Active exception id from the schedule pattern setup records."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for revoking the exception."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => can(authz, "hrm.shifts.manage"),
    featureKey: "hrmShiftPlanning",
    execute: async (context, input) => {
      assertApplicationPermission(context, "hrm.shifts.manage");
      try {
        const { idempotencyKey: _key, ...rest } = input;
        const result = await revokePatternException({ ...actor(context), ...rest });
        return {
          ok: true,
          exceptionId: input.exceptionId,
          status: "revoked",
          assignment: result.assignment,
          generation: result.generation,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "change_schedule_board_entries",
    title: "Change Schedule Board Entries",
    description:
      "Create, revise or cancel schedule bookings with revision checks and audit reasons. Find board ids with `list_schedule_boards` and entry revisions with `get_schedule_board_window`; results include notice delivery status.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      changes: z
        .array(
          z.discriminatedUnion("op", [
            z
              .object({
                op: z.literal("create").describe("Create a booking."),
                id: UUID.describe("New booking UUID."),
                ...createFields,
              })
              .strict()
              .refine(
                (value) => Boolean(value.workerPartyId) !== Boolean(value.subject),
                "Choose exactly one booking subject.",
              ),
            z
              .object({
                op: z.literal("update").describe("Revise a booking."),
                id: ENTRY_ID,
                expectedRevision: z.number().int().positive().describe("Current booking revision."),
                fields: z
                  .object({
                    workerPartyId: UUID.optional().describe("Replacement worker id."),
                    subject: createFields.subject,
                    onDate: SCHEDULE_DATE.optional().describe("Replacement booking date."),
                    target: target.optional(),
                    projectTaskId: UUID.nullable().optional().describe("Replacement task id."),
                    departmentId: UUID.nullable().optional().describe("Replacement department id."),
                    detail: z
                      .string()
                      .max(120)
                      .nullable()
                      .optional()
                      .describe("Replacement short detail."),
                    notes: z
                      .string()
                      .max(2000)
                      .nullable()
                      .optional()
                      .describe("Replacement notes."),
                    span: span.optional().describe("Replacement span."),
                    seriesId: UUID.nullable().optional().describe("Replacement series id."),
                  })
                  .strict()
                  .refine((value) => Object.keys(value).length > 0, "Name a field to change.")
                  .refine(
                    (value) => !(value.workerPartyId && value.subject),
                    "Choose exactly one booking subject.",
                  )
                  .describe("Fields to change."),
              })
              .strict(),
            z
              .object({
                op: z.literal("cancel").describe("Cancel a booking."),
                id: ENTRY_ID,
                expectedRevision: z.number().int().positive().describe("Current booking revision."),
              })
              .strict(),
          ]),
        )
        .min(1)
        .max(500)
        .describe("Revision-checked booking changes."),
      reason: z.string().max(2000).nullable().optional().describe("Reason for the changes."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageBoard,
    execute: async (context, input) => {
      const { idempotencyKey: _key, ...body } = input;
      try {
        await requireBoard(context, input.boardId, "manage");
        const result = await applyBoardChanges({
          ...actor(context),
          boardId: input.boardId,
          changes: body.changes as BoardChange[],
          reason: body.reason ?? null,
        });
        const delivery = await deliverScheduleNotices({
          ...actor(context),
          boardName: result.boardName,
          notices: result.notices,
        });
        return {
          ok: true,
          results: result.results,
          delivery,
          distributionRefusals: result.distributionRefusals,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "publish_schedule_board",
    title: "Publish Schedule Board",
    description:
      "Publish a board's unpublished changes over a date range through its configured Flow policy. Find the board with `list_schedule_boards` and verify its publication state there.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      from: SCHEDULE_DATE.describe("First date to publish, inclusive."),
      through: SCHEDULE_DATE.describe("Last date to publish, inclusive."),
      reason: z
        .string()
        .max(2000)
        .nullable()
        .optional()
        .describe("Reason recorded with the publication."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageBoard,
    execute: async (context, input) => {
      try {
        await requireBoard(context, input.boardId, "manage");
        const result = await publishScheduleBoard({
          ...actor(context),
          boardId: input.boardId,
          from: input.from,
          through: input.through,
          reason: input.reason ?? null,
        });
        const delivery = await deliverScheduleNotices({
          ...actor(context),
          boardName: result.boardName,
          notices: result.notices,
        });
        return {
          ok: true,
          publicationId: result.publicationId,
          status: result.pending ? "pending" : "published",
          published: result.published,
          pending: result.pending,
          delivery,
          distributionRefusals: result.distributionRefusals,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "observe_schedule_attendance",
    title: "Observe Schedule Attendance",
    description:
      "Observe attendance for started bookings in a board date window, using the native attendance engine. Find the board with `list_schedule_boards` and review outcomes on its attendance view.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      ...dateSpan.shape,
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: (authz) => boardReadPermissions.some((permission) => can(authz, permission)),
    featureKey: "hrmAttendance",
    execute: async (context, input) => {
      try {
        await requireBoard(context, input.boardId, "read");
        const outcomes = await processBoardAttendance({
          ...actor(context),
          boardId: input.boardId,
          from: input.from,
          through: input.through,
        });
        return {
          ok: true,
          boardId: input.boardId,
          status: "observed",
          outcomes,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "close_schedule_shift",
    title: "Close Schedule Shift",
    description:
      "Close an ended shift after attendance is complete and current. Find the board, entry id and current revision with `get_schedule_board_window`; pass an audit reason.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      entryId: ENTRY_ID,
      expectedRevision: z.number().int().positive().describe("Current entry revision."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for closing the shift."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: true,
    openWorld: false,
    assistantConfirmation: "always",
    visibleTo: canManageBoard,
    featureKey: "hrmShiftClosing",
    execute: async (context, input) => {
      try {
        await requireBoard(context, input.boardId, "manage");
        await closeShift({
          ...actor(context),
          boardId: input.boardId,
          entryId: input.entryId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
        });
        return {
          ok: true,
          boardId: input.boardId,
          entryId: input.entryId,
          status: "closed",
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
  timeDefinition({
    name: "send_schedule_distribution",
    title: "Send Schedule Distribution",
    description:
      "Send a reviewed board schedule to its selected or automatic audience after previewing it in the native board workflow. Find the board with `list_schedule_boards`; the reviewed version and new distribution UUID come from the preview.",
    inputSchema: z.object({
      boardId: BOARD_ID,
      ...dateSpan.shape,
      audience,
      version: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .describe("Reviewed preview version hash."),
      reason: z.string().trim().min(1).max(2000).describe("Reason for sending the schedule."),
      distributionKey: UUID.describe("New UUID for this distribution request."),
      idempotencyKey: IDEMPOTENCY_KEY,
    }),
    readOnly: false,
    destructive: false,
    openWorld: true,
    assistantConfirmation: "always",
    visibleTo: canManageBoard,
    execute: async (context, input) => {
      try {
        await requireBoard(context, input.boardId, "manage");
        const result = await sendScheduleDistribution({
          ...actor(context),
          boardId: input.boardId,
          from: input.from,
          through: input.through,
          audience: input.audience as never,
          version: input.version,
          reason: input.reason,
          key: input.distributionKey,
        });
        return {
          ok: true,
          boardId: input.boardId,
          status: result.status,
          distribution: result,
          href: "/scheduling/boards",
        };
      } catch (error) {
        settleTimeRefusal(error);
      }
    },
  }),
];
