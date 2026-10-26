"use client";

import type { BoardChange, BoardTarget, BoardWindow, ChangeResult } from "./model";
import { refusalMessageFromBody } from "../../lib/api-error";
import type { ProjectProgress } from "@openbooks/engine/schedule-boards/progress";
import type { ProjectTaskOption } from "@openbooks/engine/schedule-boards/targets";
import type {
  GenerationSummary,
  PatternAssignment,
  SchedulePattern,
} from "@openbooks/engine/schedule-boards/pattern-store";
import type { ShiftRequest, SwapCandidate } from "@openbooks/engine/schedule-boards/requests";
import type {
  AttendanceBatch,
  AttendanceDevice,
  AttendanceOutcome,
  SourceCheckIn,
} from "@openbooks/engine/schedule-boards/attendance";

export type {
  GenerationSummary,
  PatternAssignment,
  SchedulePattern,
  ShiftRequest,
  SwapCandidate,
  AttendanceBatch,
  AttendanceDevice,
  AttendanceOutcome,
  SourceCheckIn,
};

/** A refusal as the server worded it, with its supported remedy. */
export class SchedulingRequestError extends Error {
  readonly remedy: string | null;
  readonly code: string | null;
  constructor(message: string, remedy: string | null, code: string | null) {
    super(message);
    this.remedy = remedy;
    this.code = code;
  }
}

async function request<T>(
  url: string,
  init: RequestInit | undefined,
  fallback: string,
): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    let body: { error?: unknown; remedy?: unknown; code?: unknown } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // A body that is not JSON keeps the status-derived message below.
    }
    // The message reads through the shared helper with the remedy stripped
    // (it rides separately below); the opaque probe code keeps the fallback.
    const raw = typeof body.error === "string" ? body.error : null;
    const message =
      raw === "not_found"
        ? fallback
        : (refusalMessageFromBody({ ...body, remedy: undefined }, { fallback }) ?? fallback);
    throw new SchedulingRequestError(
      message,
      typeof body.remedy === "string" ? body.remedy : null,
      typeof body.code === "string" ? body.code : null,
    );
  }
  return (await response.json()) as T;
}

const base = (boardId: string) => `/api/scheduling/boards/${encodeURIComponent(boardId)}`;

export function fetchWindow(
  boardId: string,
  from: string,
  through: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<BoardWindow> {
  return request<BoardWindow>(
    `${base(boardId)}/window?from=${from}&through=${through}`,
    { signal },
    fallback,
  );
}

export function saveChanges(
  boardId: string,
  changes: readonly BoardChange[],
  fallback: string,
  reason?: string,
): Promise<{
  results: ChangeResult[];
  distributionRefusals?: { message: string; remedy: string }[];
}> {
  return request(
    `${base(boardId)}/changes`,
    { method: "POST", body: JSON.stringify({ changes, reason: reason ?? null }) },
    fallback,
  );
}

export function publish(
  boardId: string,
  from: string,
  through: string,
  fallback: string,
): Promise<{
  published: number;
  pending: boolean;
  publicationId: string | null;
  distributionRefusals?: { message: string; remedy: string }[];
}> {
  return request(
    `${base(boardId)}/publish`,
    { method: "POST", body: JSON.stringify({ from, through }) },
    fallback,
  );
}

export function searchTargets(
  boardId: string,
  query: string,
  fallback: string,
  signal?: AbortSignal,
): Promise<{ targets: BoardTarget[] }> {
  return request(
    `${base(boardId)}/targets?q=${encodeURIComponent(query)}&limit=12`,
    { signal },
    fallback,
  );
}

export function projectTasks(
  boardId: string,
  projectId: string,
  fallback: string,
): Promise<{ tasks: ProjectTaskOption[] }> {
  return request(
    `${base(boardId)}/tasks?projectId=${encodeURIComponent(projectId)}`,
    undefined,
    fallback,
  );
}

export function projectProgress(
  boardId: string,
  projectId: string,
  fallback: string,
): Promise<ProjectProgress> {
  return request(
    `${base(boardId)}/progress?projectId=${encodeURIComponent(projectId)}`,
    undefined,
    fallback,
  );
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export function boardAssignments(
  boardId: string,
  fallback: string,
): Promise<{ assignments: PatternAssignment[]; patterns: SchedulePattern[] }> {
  return request(`${base(boardId)}/assignments`, undefined, fallback);
}

export function assignPattern(
  boardId: string,
  body: {
    id: string;
    patternId: string;
    workerPartyId: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    reason: string;
  },
  fallback: string,
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  return request(`${base(boardId)}/assignments`, json("POST", body), fallback);
}

const assignment = (id: string) => `/api/scheduling/assignments/${encodeURIComponent(id)}`;

export function closeAssignment(
  id: string,
  body: {
    action: "end" | "cancel";
    expectedRevision: number;
    effectiveTo?: string;
    reason: string;
  },
  fallback: string,
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  return request(assignment(id), json("PATCH", body), fallback);
}

export function generateAssignment(id: string, fallback: string): Promise<GenerationSummary> {
  return request(`${assignment(id)}/generate`, json("POST", {}), fallback);
}

export type PatternExceptionBody =
  | { kind: "omit"; occursOn: string; slotIndex: number; reason: string }
  | {
      kind: "select_instant";
      occursOn: string;
      slotIndex: number;
      startsAt: string;
      endsAt: string;
      reason: string;
    };

export function recordPatternException(
  id: string,
  body: PatternExceptionBody,
  fallback: string,
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  return request(`${assignment(id)}/exceptions`, json("POST", body), fallback);
}

export function revokePatternException(
  id: string,
  reason: string,
  fallback: string,
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  return request(
    `/api/scheduling/pattern-exceptions/${encodeURIComponent(id)}/revoke`,
    json("POST", { reason }),
    fallback,
  );
}

export function boardShiftRequests(
  boardId: string,
  status: "open" | "all",
  fallback: string,
): Promise<{ requests: ShiftRequest[] }> {
  return request(`${base(boardId)}/requests?status=${status}`, undefined, fallback);
}

export function processAttendance(
  boardId: string,
  from: string,
  through: string,
  fallback: string,
): Promise<{ outcomes: AttendanceOutcome[] }> {
  return request(`${base(boardId)}/attendance`, json("POST", { from, through }), fallback);
}

export function attendanceDevices(fallback: string): Promise<{ devices: AttendanceDevice[] }> {
  return request("/api/scheduling/attendance/devices", undefined, fallback);
}

export function admitCheckIns(
  deviceId: string,
  body: {
    id: string;
    completeThrough: string | null;
    sourceEvidence: Record<string, unknown>;
    reason: string;
    events: SourceCheckIn[];
  },
  fallback: string,
): Promise<{ batch: AttendanceBatch; outcomes: AttendanceOutcome[] }> {
  return request(
    `/api/scheduling/attendance/devices/${encodeURIComponent(deviceId)}/batches`,
    json("POST", body),
    fallback,
  );
}

export function closeShift(
  boardId: string,
  entryId: string,
  expectedRevision: number,
  reason: string,
  fallback: string,
): Promise<{ closed: true }> {
  return request(
    `${base(boardId)}/entries/${encodeURIComponent(entryId)}/close`,
    json("POST", { expectedRevision, reason }),
    fallback,
  );
}

export function ownShiftRequests(fallback: string): Promise<{ requests: ShiftRequest[] }> {
  return request("/api/me/schedule/requests", undefined, fallback);
}

export function submitOwnShiftRequest(
  body: {
    id: string;
    entryId: string;
    expectedRevision: number;
    kind: "release" | "change" | "swap";
    change?: { starts: string; ends: string; breakMinutes: number } | null;
    counterpartEntryId?: string | null;
    counterpartRevision?: number | null;
    reason: string;
  },
  fallback: string,
): Promise<{ request: ShiftRequest }> {
  return request("/api/me/schedule/requests", json("POST", body), fallback);
}

export function actOnOwnShiftRequest(
  id: string,
  body: { action: "withdraw" | "accept" | "decline"; expectedRevision: number; reason?: string },
  fallback: string,
): Promise<{ request: ShiftRequest }> {
  return request(
    `/api/me/schedule/requests/${encodeURIComponent(id)}`,
    json("POST", body),
    fallback,
  );
}

export function swapCandidates(
  entryId: string,
  fallback: string,
): Promise<{ candidates: SwapCandidate[] }> {
  return request(
    `/api/me/schedule/swap-candidates?entryId=${encodeURIComponent(entryId)}`,
    undefined,
    fallback,
  );
}
