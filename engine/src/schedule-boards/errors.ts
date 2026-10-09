/**
 * The scheduling refusal. Every refusal names what is wrong and how to fix
 * it; route boundaries carry `code` and `remedy` to the operator unchanged.
 */
export class ScheduleError extends Error {
  readonly status: number;
  readonly code: string;
  readonly remedy?: string;
  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      remedy?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ScheduleError";
    this.status = options.status ?? 422;
    this.code = options.code ?? "schedule_refused";
    if (options.remedy) this.remedy = options.remedy;
  }
}

const CHECK_REFUSALS: Record<string, readonly [string, string]> = {
  schedule_entries_span: ["The booking must end after it starts, leave working time after its break, and last at most 48 hours.", "Correct the start, end or break."],
  schedule_boards_day_span: ["The board's working day must end after it starts and leave time after the break.", "Correct the day start, day end or break in the board settings."],
  schedule_boards_views_valid: ["The selected views are not available for this kind of board.", "Choose views offered for the board's row type."],
  schedule_boards_default_view_listed: ["The default view must be one of the board's views.", "Pick a default view from the enabled views."],
  schedule_boards_people_settings: ["Timesheet, crew and field ticket pre-fill and notifications apply to people boards only.", "Turn these settings off for a task or resource board."],
  schedule_boards_resource_kind: ["The board's resource kind or scope is not valid.", "Select equipment units or locations; equipment boards cannot use department or location scope."],
  schedule_boards_cell_color_rules: ["A cell color rule is not valid.", "Choose a field and match, enter a value, and use a six-digit hex color such as #38bdf8."],
  schedule_boards_weekend_days: ["The weekend days are not valid.", "Select days of the week in Board settings."],
  schedule_boards_distribution_entity: ["Whole-board reports need a legal entity.", "Choose a legal entity in Board Settings or use personal reports."],
  schedule_entries_subject: ["A booking needs exactly one person or resource.", "Reload the board and select a row belonging to its resource kind."],
};

type DatabaseCause ={ code?: string; constraint?: string; message?: string; where?: string; cause?: unknown };

/**
 * Translate a database refusal raised by the scheduling tables into the
 * operator's terms. The ledger's guard functions already word their
 * refusals for operators; constraint violations are named here. Anything
 * unrecognized is returned unchanged so the original cause is preserved.
 */
export function scheduleDatabaseRefusal(error: unknown, context: { personName?: string } = {}): unknown {
  const seen = new Set<object>();
  let cause: unknown = error;
  while (cause && typeof cause === "object" && !seen.has(cause)) {
    seen.add(cause);
    const detail = cause as DatabaseCause;
    if (
      (detail.code === "42P01" &&
        /schedule_(?:boards|codes|entries|source_records|distributions|distribution_recipients|resource_recipients)/.test(
          detail.message ?? "",
        )) ||
      (detail.code === "42703" &&
        /automatic_delivery_policy|show_hours_column|distribution_visibility|resource_kind|cell_color_rules|show_totals|weekend_days|equipment_unit_id|resource_location_id|day_policy_known/.test(
          detail.message ?? "",
        ))
    ) {
      return new ScheduleError("Scheduling needs its database upgrade before it can be used.", {
        status: 409,
        code: "schedule_upgrade_required",
        remedy: "Ask an administrator to apply the pending database migrations.",
      });
    }
    if ((detail.code === "23514" || detail.code === "P0001") && /schedule_(?:entr|board|code|source_record|distribution|resource_recipient)|schedule_entry_assert/.test(`${detail.where ?? ""} ${detail.constraint ?? ""}`) && detail.message && !detail.constraint) {
      return new ScheduleError(detail.message, { code: "schedule_refused" });
    }
    if (detail.code === "23514" && detail.constraint && CHECK_REFUSALS[detail.constraint]) {
      const [message, remedy] = CHECK_REFUSALS[detail.constraint]!;
      return new ScheduleError(message, { code: "schedule_invalid", remedy });
    }
    if (detail.code === "23P01" && ["schedule_entries_no_double_booking", "schedule_entries_equipment_no_double_booking", "schedule_entries_location_no_double_booking"].includes(detail.constraint ?? "")) {
      return new ScheduleError(`${context.personName ?? "This person or resource"} is already booked at that time.`, {
        code: "schedule_double_booked",
        remedy: "Remove or move the other booking first, or choose another person, resource or time.",
      });
    }
    if (detail.code === "23505" && /schedule_resource_recipients_(equipment|location)/.test(detail.constraint ?? "")) {
      return new ScheduleError("This resource already has an active board contact.", {status:409,code:"schedule_stale",remedy:"Edit the existing association or retire it before choosing another contact."});
    }
    if (detail.code === "23505" && /schedule_distributions_/.test(detail.constraint ?? "")) {
      return new ScheduleError("Another send already owns this reviewed schedule.", {status:409,code:"schedule_stale",remedy:"Reload its native Flow and delivery status; the same version is not sent twice."});
    }
    if (detail.code === "23505" && detail.constraint === "schedule_boards_org_id_code_key") {
      return new ScheduleError("Another board already uses this code.", { code: "schedule_board_code_taken", remedy: "Choose a different board code." });
    }
    if (detail.code === "23505" && detail.constraint === "schedule_entries_org_id_supersedes_id_key") {
      return new ScheduleError("This booking was already changed by someone else.", { status: 409, code: "schedule_stale", remedy: "Reload the board and make the change again." });
    }
    if (detail.code === "23503" && detail.constraint?.startsWith("schedule_entries_")) {
      return new ScheduleError("A booking reference is not available in this organization.", { code: "schedule_reference_unavailable", remedy: "Reload the board and choose the person or target again." });
    }
    if (detail.code === "40001" || detail.code === "40P01") {
      return new ScheduleError("The schedule changed while this was being saved.", { status: 409, code: "schedule_stale", remedy: "Reload the board and try again; nothing in this change was saved." });
    }
    cause = detail.cause;
  }
  return error;
}
