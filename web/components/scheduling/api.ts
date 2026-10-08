'use client'

import type { BoardChange, BoardTarget, BoardWindow, ChangeResult } from './model'
import type { ProjectProgress } from '@openbooks/engine/src/schedule-boards/progress.ts'
import type { ProjectTaskOption } from '@openbooks/engine/src/schedule-boards/targets.ts'

/** A refusal as the server worded it, with its supported remedy. */
export class SchedulingRequestError extends Error {
  readonly remedy: string | null
  readonly code: string | null
  constructor(message: string, remedy: string | null, code: string | null) {
    super(message)
    this.remedy = remedy
    this.code = code
  }
}

async function request<T>(url: string, init: RequestInit | undefined, fallback: string): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  if (!response.ok) {
    let body: { error?: unknown; remedy?: unknown; code?: unknown } = {}
    try {
      body = (await response.json()) as typeof body
    } catch {
      // A body that is not JSON keeps the status-derived message below.
    }
    const message = typeof body.error === 'string' && body.error !== 'not_found' ? body.error : fallback
    throw new SchedulingRequestError(message, typeof body.remedy === 'string' ? body.remedy : null, typeof body.code === 'string' ? body.code : null)
  }
  return (await response.json()) as T
}

const base = (boardId: string) => `/api/scheduling/boards/${encodeURIComponent(boardId)}`

export function fetchWindow(boardId: string, from: string, through: string, fallback: string): Promise<BoardWindow> {
  return request<BoardWindow>(`${base(boardId)}/window?from=${from}&through=${through}`, undefined, fallback)
}

export function saveChanges(boardId: string, changes: readonly BoardChange[], fallback: string, reason?: string): Promise<{ results: ChangeResult[] }> {
  return request(`${base(boardId)}/changes`, { method: 'POST', body: JSON.stringify({ changes, reason: reason ?? null }) }, fallback)
}

export function publish(boardId: string, from: string, through: string, fallback: string): Promise<{ published: number }> {
  return request(`${base(boardId)}/publish`, { method: 'POST', body: JSON.stringify({ from, through }) }, fallback)
}

export function searchTargets(boardId: string, query: string, fallback: string, signal?: AbortSignal): Promise<{ targets: BoardTarget[] }> {
  return request(`${base(boardId)}/targets?q=${encodeURIComponent(query)}&limit=12`, { signal }, fallback)
}

export function projectTasks(boardId: string, projectId: string, fallback: string): Promise<{ tasks: ProjectTaskOption[] }> {
  return request(`${base(boardId)}/tasks?projectId=${encodeURIComponent(projectId)}`, undefined, fallback)
}

export function projectProgress(boardId: string, projectId: string, fallback: string): Promise<ProjectProgress> {
  return request(`${base(boardId)}/progress?projectId=${encodeURIComponent(projectId)}`, undefined, fallback)
}
