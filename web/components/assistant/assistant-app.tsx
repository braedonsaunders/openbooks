'use client'

// The assistant experience: a multi-conversation sidebar + streaming thread with tool-use cards +
// composer. Streams via the UI-message protocol (readUIMessageStream) so the
// SAME parts[] renderer serves live tokens and reloaded transcripts.

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  parseJsonEventStream,
  readUIMessageStream,
  uiMessageChunkSchema,
  type UIMessageChunk,
} from 'ai'
import {
  ArrowDown,
  Loader2,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react'
import { Button, EmptyState, cn } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { MessageParts } from './message-parts'
import {
  forgetDeletedConversation,
  provisionalTitle,
  reconcileConversations,
  rememberDeletedConversation,
  removeConversationRow,
  renameConversationRow,
  syncServerConversations,
  upsertProvisionalConversation,
  withoutDeletedConversations,
} from './sidebar-state'
import {
  anchorScrollTop,
  countAssistantTurns,
  formatMessageTimestamp,
  isViewportAtBottom,
  MESSAGE_PAGE_SIZE,
  reconcileThreadAfterStop,
  TITLE_REFRESH_DELAY_MS,
} from './thread-state'
import {
  abortTurn,
  attachLoop,
  beginTurn,
  completeTurn,
  controllerFor,
  detachLoop,
  dropTurn,
  failTurn,
  hasLiveLoop,
  readTurn,
  rekeyTurn,
  settleTurn,
  subscribeTurns,
  syncTurn,
  turnRevision,
  writeTurnParts,
  type TurnEntry,
} from './turn-store'

type Role = 'user' | 'assistant' | 'system'
type ChatMessage = {
  id: string
  role: Role
  parts: unknown[]
  createdAt?: string
  /** Present when the server row behind this message is a live run. */
  run?: { runId: string }
}
/** Reattach poll cadence for runs this view did not start. */
const RUN_FOLLOW_INTERVAL_MS = 1_500

/**
 * Compose the persisted base with the live tail of the viewed conversation.
 * A live tail replaces its own running row (a reattached base still carries
 * the server's last snapshot of the same turn) so the turn never renders
 * twice.
 */
function composeVisible(base: ChatMessage[], live: TurnEntry | undefined): ChatMessage[] {
  if (!live) return base
  return [
    ...base.filter((m) => !m.run),
    { id: live.userId, role: 'user', parts: [{ type: 'text', text: live.userText }] },
    { id: live.assistantId, role: 'assistant', parts: live.parts },
  ]
}

export type StoredMessage = {
  id: string
  role: Role
  content: string
  data: { parts?: unknown[] } | null
  /** Server timestamp; drives per-message timestamps. Absent on optimistic rows. */
  createdAt?: string
}

export type ConversationSummary = { id: string; title: string; updatedAt: string }

const MAX_PROMPT_CHARS = 32_000
const TITLE_MAX_CHARS = 120

export function toChatMessage(message: StoredMessage): ChatMessage {
  const storedParts = message.data?.parts
  const data = message.data as { kind?: unknown; status?: unknown } | null
  return {
    id: message.id,
    role: message.role,
    parts:
      Array.isArray(storedParts) && storedParts.length > 0
        ? storedParts
        : [{ type: 'text', text: message.content }],
    ...(message.createdAt ? { createdAt: message.createdAt } : {}),
    // A server-running run row flags itself so the view can follow it even
    // when this client did not start the turn (reload, second tab).
    ...(data?.kind === 'agent-turn' && data?.status === 'running'
      ? { run: { runId: message.id } }
      : {}),
  }
}

export function AssistantApp({
  conversations,
  activeId,
  initialMessages,
  canWrite,
  canConfigureAi = false,
  aiEnabled,
  initialPrompt,
  initialFindingId,
}: {
  conversations: ConversationSummary[]
  activeId: string | null
  initialMessages: StoredMessage[]
  canWrite: boolean
  canConfigureAi?: boolean
  aiEnabled: boolean
  /** Prompt passed via /assistant?q= (the ⌘K launcher); auto-sent once. */
  initialPrompt?: string
  /** Finding id passed via /assistant?finding= (the workbench "Ask about this"). */
  initialFindingId?: string
}) {
  const t = useTranslations('assistant')
  const admin = useTranslations('admin.ai')
  const common = useTranslations('common.actions')
  const router = useRouter()
  // messages is the PERSISTED base (server transcript). The live tail of an
  // in-flight turn composes on top at render from the conversation-keyed
  // turn store — never from view-local state — so switching chats,
  // remounting, or reloading re-adopts the same live progress.
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages.map(toChatMessage))
  // Seeded from the loader payload minus this tab's deletions: a remount may
  // serve a stale prefetched list that still carries a deleted thread.
  const [convos, setConvos] = useState(() => withoutDeletedConversations(conversations))
  const [currentId, setCurrentId] = useState<string | null>(activeId)
  // Provisional view key for a new chat until the server answers with its id.
  // (The begun store entry already renders the optimistic tail, so no
  // separate pending-bubble state is needed.)
  const [pendingKey, setPendingKey] = useState<string | null>(null)
  // x-run-id per conversation, for the explicit Stop endpoint.
  const runIdsRef = useRef(new Map<string, string>())
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const viewKey = currentId ?? pendingKey
  // Mirrors for stable callbacks and async adopts. Written in effects (never
  // during render) so the viewed key is always current when handlers fire.
  const viewKeyRef = useRef<string | null>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const convosRef = useRef<ConversationSummary[]>(convos)
  useEffect(() => {
    viewKeyRef.current = viewKey
    messagesRef.current = messages
    convosRef.current = convos
  })
  // Re-render whenever the viewed conversation's turn entry changes. The
  // snapshot closes over this render's key (a primitive revision number, so
  // no caching hazard); the subscription itself is stable.
  useSyncExternalStore(subscribeTurns, () => turnRevision(viewKey), () => -1)
  const live = readTurn(viewKey)
  const visibleMessages = composeVisible(messages, live)
  const streaming = live?.streaming ?? false
  const liveError = live && !live.streaming ? live.error : null
  // Workbench finding context: attached to turns until removed. A fresh chat
  // (Link to /assistant) remounts and reads the URL again, so no clearing
  // logic is needed here beyond the dismiss chip.
  const [findingId, setFindingId] = useState<string | null>(initialFindingId ?? null)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const autoSentPrompt = useRef<string | null>(null)
  // Assistant turns this mounted panel has already shown. Raised on every
  // normally completed turn so the stop-reconcile below can tell a persisted
  // transcript that has caught up from one that is still behind.
  const completedTurnsRef = useRef(countAssistantTurns(initialMessages.map(toChatMessage)))
  // Threads this client created whose id the server list may not know yet.
  // They stay pinned at the top of the sidebar until a refresh confirms them.
  const provisionalIdsRef = useRef<Set<string>>(new Set())
  // Only a thread's first completed turn can change its title (later turns
  // leave it alone), so only that turn schedules the delayed title refresh.
  const firstTurnRef = useRef(initialMessages.length === 0)
  const titleRefreshTimerRef = useRef<number | null>(null)

  // A refresh timer must never fire after unmount.
  useEffect(() => {
    const timer = titleRefreshTimerRef
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    }
  }, [])
  // Long-history paging: whether a page exists above the visible head. A full
  // first page optimistically shows the button; the first probe or page load
  // resolves the truth (a thread of exactly one page hides it again).
  const [hasOlder, setHasOlder] = useState(initialMessages.length >= MESSAGE_PAGE_SIZE)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const prependAnchorRef = useRef<{
    firstMessageId: string | undefined
    scrollHeight: number
    scrollTop: number
  } | null>(null)

  // Stick-to-bottom: auto-scroll follows streamed chunks only while the
  // reader is already at the bottom. Any upward scroll detaches so history
  // stays readable; jumping back re-attaches. The ref mirrors the state for
  // stream loops and callbacks that cannot wait for a render. Assignment is
  // direct on the viewport (never scrollIntoView) so no ancestor jumps.
  const [stuckToBottom, setStuckToBottom] = useState(true)
  const stuckRef = useRef(true)
  useEffect(() => {
    stuckRef.current = stuckToBottom
  }, [stuckToBottom])

  const onViewportScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget
    const atBottom = isViewportAtBottom(el.scrollTop, el.clientHeight, el.scrollHeight)
    stuckRef.current = atBottom
    setStuckToBottom(atBottom)
  }, [])

  const scrollToBottom = useCallback(() => {
    if (!stuckRef.current) return
    const viewport = viewportRef.current
    if (!viewport) return
    window.requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight
    })
  }, [])

  const jumpToLatest = useCallback(() => {
    stuckRef.current = true
    setStuckToBottom(true)
    // Paint may still be pending (fresh turn, adopted transcript), so the
    // snap runs on the next frame, after the new rows exist.
    window.requestAnimationFrame(() => {
      const viewport = viewportRef.current
      if (viewport) viewport.scrollTop = viewport.scrollHeight
    })
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/conversations')
      if (!res.ok) return
      const body = (await res.json()) as { items: ConversationSummary[] }
      // The server list is authoritative, except threads this client created
      // that the server does not know yet — a rename or delete issued
      // mid-stream must not drop the streaming row — and except threads this
      // tab deleted, which a stale refetch may still carry.
      setConvos((prev) => {
        const { items, provisionalIds } = reconcileConversations(
          prev,
          withoutDeletedConversations(body.items),
          provisionalIdsRef.current,
        )
        provisionalIdsRef.current = provisionalIds
        return items
      })
    } catch {
      // best-effort — the sidebar simply stays stale
    }
  }, [])

  // Fold fresh loader payloads into the sidebar on navigation and refresh.
  // State otherwise wins forever (useState seeds once), so a remount served
  // from a stale prefetched payload would resurrect a thread this tab
  // deleted — and the background revalidation that follows could never
  // remove it. Tombstones make every payload honour the deletion; the
  // provisional pins still protect a thread the server does not know yet.
  useEffect(() => {
    setConvos((prev) => {
      const { items, provisionalIds } = syncServerConversations(
        prev,
        conversations,
        provisionalIdsRef.current,
        activeId,
      )
      provisionalIdsRef.current = provisionalIds
      return items
    })
  }, [conversations, activeId])

  // Lightweight probe: is there any history above the given head? Resolves
  // the optimistic initial flag without loading a page.
  const probeHasOlder = useCallback(async (convId: string, headId: string | undefined) => {
    if (!headId) {
      setHasOlder(false)
      return
    }
    try {
      const res = await fetch(
        `/api/assistant/conversations/${convId}?before=${encodeURIComponent(headId)}&limit=1`,
      )
      if (!res.ok) return
      const body = (await res.json()) as { messages: StoredMessage[]; hasOlder: boolean }
      setHasOlder(body.hasOlder)
    } catch {
      // best-effort — a failed probe hides the button rather than erroring
      setHasOlder(false)
    }
  }, [])

  async function loadOlder() {
    const viewport = viewportRef.current
    const first = messages.find((m) => m.role !== 'system')
    if (!viewport || !currentId || !first || loadingOlder || streaming || !hasOlder) return
    prependAnchorRef.current = {
      firstMessageId: first.id,
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    }
    setLoadingOlder(true)
    setError(null)
    try {
      const res = await fetch(
        `/api/assistant/conversations/${currentId}?before=${encodeURIComponent(first.id)}&limit=${MESSAGE_PAGE_SIZE}`,
      )
      if (!res.ok) throw new Error()
      const body = (await res.json()) as { messages: StoredMessage[]; hasOlder: boolean }
      const older = body.messages.map(toChatMessage)
      setMessages((prev) => [...older, ...prev])
      setHasOlder(body.hasOlder)
    } catch {
      prependAnchorRef.current = null
      setError(t('loadEarlierFailed'))
    } finally {
      setLoadingOlder(false)
    }
  }

  // Prepending history must not move the message the reader was looking at:
  // restore the exact distance from the old head by the height the new rows
  // added above it.
  useLayoutEffect(() => {
    const anchor = prependAnchorRef.current
    const viewport = viewportRef.current
    if (!anchor || !viewport || messages[0]?.id === anchor.firstMessageId) return
    viewport.scrollTop = anchorScrollTop(anchor.scrollTop, anchor.scrollHeight, viewport.scrollHeight)
    prependAnchorRef.current = null
  }, [messages])

  // Adopt the newly shown conversation: the persisted base resets to its
  // transcript while in-flight turns keep streaming in the conversation-keyed
  // store (a refresh then converges the tail). Guarded on the id so sidebar
  // refreshes and re-renders never reset the base mid-turn.
  const prevActiveIdRef = useRef(activeId)
  useEffect(() => {
    if (prevActiveIdRef.current === activeId) return
    const droppedPending = pendingKey
    prevActiveIdRef.current = activeId
    setPendingKey(null)
    if (droppedPending) dropTurn(droppedPending)
    setCurrentId(activeId)
    const base = initialMessages.map(toChatMessage)
    setMessages(base)
    // A newly opened thread starts stuck to the bottom (latest visible);
    // any upward scroll detaches from there.
    jumpToLatest()
    completedTurnsRef.current = countAssistantTurns(base)
    firstTurnRef.current = base.length === 0
    if (!activeId) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/assistant/conversations/${activeId}`)
        if (!res.ok || cancelled || prevActiveIdRef.current !== activeId) return
        const body = (await res.json()) as { messages: StoredMessage[] }
        const server = body.messages.map(toChatMessage)
        if (cancelled || prevActiveIdRef.current !== activeId) return
        setMessages(server)
        // The adopted transcript replaces the base: re-attach and snap so
        // a long history still opens on the latest turn.
        jumpToLatest()
        completedTurnsRef.current = countAssistantTurns(server)
        firstTurnRef.current = server.length === 0
        // The fresh transcript carries every settled turn: drop redundant
        // tails, but never a turn that is still streaming.
        const entry = readTurn(activeId)
        if (entry && !entry.streaming) settleTurn(activeId)
      } catch {
        // keep the loader-provided base
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeId, initialMessages, jumpToLatest, pendingKey])

  // Follow a server-running turn this view did not start (page reload, a turn
  // started in another tab): poll its event log until terminal, then adopt
  // the persisted transcript. Live loops feed the store directly instead.
  useEffect(() => {
    if (!currentId || hasLiveLoop(viewKey)) return
    const running = messages.find((m) => m.run?.runId)
    if (!running?.run) return
    const runId = running.run.runId
    const conversationId = currentId
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch(`/api/assistant/runs/${runId}`)
        if (!res.ok || cancelled) return
        const body = (await res.json()) as {
          run: { status: string; parts: unknown[]; revision: number } | null
        }
        if (!body.run || cancelled) return
        const status = body.run.status
        syncTurn({ conversationId, status: status as 'running', parts: body.run.parts, revision: body.run.revision })
        if (status !== 'running' && !cancelled) {
          try {
            const t = await fetch(`/api/assistant/conversations/${conversationId}`)
            if (t.ok && !cancelled) {
              const adopted = ((await t.json()) as { messages: StoredMessage[] }).messages.map(toChatMessage)
              setMessages(adopted)
              completedTurnsRef.current = countAssistantTurns(adopted)
            }
          } catch {
            // keep the synced tail; the next navigation converges
          }
          settleTurn(conversationId)
        }
      } catch {
        // transient: the next tick retries
      }
    }
    void poll()
    const timer = window.setInterval(poll, RUN_FOLLOW_INTERVAL_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [currentId, messages, viewKey])

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim()
      if (!text || text.length > MAX_PROMPT_CHARS || !aiEnabled) return

      const conversationId = currentId
      const stamp = Date.now()
      // One turn per conversation; the entry (and its parts) is keyed by the
      // conversation — or a provisional key until a new chat answers.
      const key = conversationId ?? `pending:${stamp}`
      if (hasLiveLoop(key) || readTurn(key)?.streaming) return
      if (!conversationId) setPendingKey(key)
      // The read signal ends only this view's SSE consumption (unmount,
      // stop): the server-owned run continues regardless.
      const ac = controllerFor(key)
      setError(null)
      setSidebarOpen(false)
      beginTurn(key, conversationId, {
        userId: `u-${stamp}`,
        assistantId: `a-${stamp}`,
        userText: text,
      })
      attachLoop(key)
      // Sending re-attaches: the new turn starts at the bottom by choice.
      jumpToLatest()
      let turnKey = key
      let resolvedConversationId = conversationId
      let lastParts: unknown[] = []
      let producedParts = false
      let completedNormally = false
      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, prompt: text, ...(findingId ? { findingId } : {}) }),
          signal: ac.signal,
        })
        const responseConversationId = res.headers.get('x-conversation-id')
        const responseRunId = res.headers.get('x-run-id')
        if (responseConversationId) {
          resolvedConversationId = responseConversationId
          if (responseRunId) runIdsRef.current.set(responseConversationId, responseRunId)
          if (!conversationId) {
            rekeyTurn(key, responseConversationId)
            turnKey = responseConversationId
            setPendingKey(null)
            setCurrentId(responseConversationId)
            // Reflect the new thread in the URL without unmounting the stream.
            window.history.replaceState(null, '', `/assistant/${responseConversationId}`)
            // Instant sidebar: pin the new thread at the top with the same
            // provisional title the server stored; the end-of-turn refresh
            // reconciles it against the server list.
            provisionalIdsRef.current.add(responseConversationId)
            const entry = {
              id: responseConversationId,
              title: provisionalTitle(text),
              updatedAt: new Date().toISOString(),
            }
            setConvos((prev) => upsertProvisionalConversation(prev, entry))
          }
        }
        if (!res.ok || !res.body) {
          failTurn(turnKey, res.status === 503 ? t('errors.notConfigured') : t('errors.failed'))
          return
        }
        // The HTTP body is an SSE byte stream — parse it into UIMessageChunks
        // before handing it to readUIMessageStream (matches the SDK transport).
        // Chunks land in the conversation-keyed store (the render composes
        // them), never in view-local state, so the turn survives navigation.
        const chunkStream = parseJsonEventStream({
          stream: res.body,
          schema: uiMessageChunkSchema,
        }).pipeThrough(
          new TransformStream<{ success: boolean; value?: UIMessageChunk }, UIMessageChunk>({
            transform(part, controller) {
              if (part.success && part.value) controller.enqueue(part.value)
            },
          }),
        )
        for await (const message of readUIMessageStream({ stream: chunkStream })) {
          lastParts = message.parts as unknown[]
          if (lastParts.length > 0) producedParts = true
          writeTurnParts(turnKey, lastParts)
          scrollToBottom()
        }
        completedNormally = true
        // A turn that ended without producing anything (e.g. the provider
        // rejected the request) would otherwise vanish silently.
        if (lastParts.length === 0 && !ac.signal.aborted) failTurn(turnKey, t('errors.failed'))
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') failTurn(turnKey, t('errors.failed'))
      } finally {
        detachLoop(turnKey)
        runIdsRef.current.delete(turnKey)
        if (!mountedRef.current) {
          // Unmounted as the loop ended: the server persisted the turn;
          // keep its final parts so a return adopts instantly, and let the
          // next transcript load converge and drop the tail.
          completeTurn(turnKey, lastParts)
        } else if (!resolvedConversationId) {
          // The turn never started server-side — drop the optimistic tail
          // and release the provisional key.
          dropTurn(turnKey)
          setPendingKey(null)
        } else if (ac.signal.aborted) {
          // Reconcile with what actually got persisted for the stopped turn —
          // unless persistence has not caught up yet, in which case the
          // completed stream stays visible until the host reaches the floor.
          await new Promise((resolve) => window.setTimeout(resolve, 150))
          try {
            const res = await fetch(`/api/assistant/conversations/${resolvedConversationId}`)
            if (res.ok && viewKeyRef.current === resolvedConversationId) {
              const body = (await res.json()) as { messages: StoredMessage[] }
              const server = body.messages.map(toChatMessage)
              const base = messagesRef.current
              const adopted = reconcileThreadAfterStop(base, server, completedTurnsRef.current)
              setMessages(adopted)
              if (adopted === server) settleTurn(resolvedConversationId)
              // An adopted server window may itself sit below older history.
              if (server.length >= MESSAGE_PAGE_SIZE) {
                void probeHasOlder(
                  resolvedConversationId,
                  server.find((m) => m.role !== 'system')?.id,
                )
              }
            }
          } catch {
            // keep the streamed state
          }
        } else if (viewKeyRef.current === resolvedConversationId) {
          // Normal completion while viewing: fold the tail into the base.
          const tail = readTurn(turnKey)
          if (tail && producedParts) {
            setMessages((prev) => [
              ...prev,
              { id: tail.userId, role: 'user', parts: [{ type: 'text', text: tail.userText }] },
              { id: tail.assistantId, role: 'assistant', parts: tail.parts },
            ])
            completedTurnsRef.current += 1
          }
          settleTurn(turnKey)
        } else {
          // Completed while viewing another conversation: keep the final
          // parts for instant adopt on return; the return's transcript load
          // converges and drops the tail.
          completeTurn(turnKey, lastParts)
        }
        if (mountedRef.current) void refreshConversations()
        // The server generates the thread title after the stream closes, so
        // the refresh above usually still shows the placeholder: one delayed
        // second pass picks the generated title up. Bounded to the thread's
        // first turn — the only turn that can change the title.
        if (
          resolvedConversationId &&
          producedParts &&
          completedNormally &&
          !ac.signal.aborted &&
          firstTurnRef.current &&
          titleRefreshTimerRef.current === null &&
          viewKeyRef.current === resolvedConversationId
        ) {
          firstTurnRef.current = false
          titleRefreshTimerRef.current = window.setTimeout(() => {
            titleRefreshTimerRef.current = null
            void refreshConversations()
          }, TITLE_REFRESH_DELAY_MS)
        }
      }
    },
    [aiEnabled, currentId, findingId, jumpToLatest, probeHasOlder, refreshConversations, scrollToBottom, t],
  )

  // Auto-send a prompt passed via ?q= (from the ⌘K launcher) once per distinct
  // query. Wait for any active turn to finish so navigation cannot drop it.
  useEffect(() => {
    const prompt = initialPrompt?.trim()
    if (!prompt || !aiEnabled || streaming || autoSentPrompt.current === prompt) {
      return
    }
    autoSentPrompt.current = prompt
    void send(prompt)
  }, [aiEnabled, initialPrompt, send, streaming])

  // Stable identity so the memoed composer is not re-rendered by transcript
  // updates such as streamed tokens. Stop ends the SERVER run explicitly —
  // closing the stream alone no longer stops it — then ends local reading.
  const stop = useCallback(() => {
    const key = viewKeyRef.current
    if (!key) return
    const runId = runIdsRef.current.get(key)
    if (runId) {
      void fetch(`/api/assistant/runs/${runId}/abort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => {})
    }
    abortTurn(key)
  }, [])

  // Stable identity so the memoed composer (and its textarea) is not
  // re-rendered by transcript updates such as streamed tokens.
  const sendToComposer = useCallback(
    (text: string) => {
      void send(text)
    },
    [send],
  )

  async function doRename(id: string, title: string) {
    setRenamingId(null)
    const clean = title.trim()
    if (!clean) return
    try {
      const res = await fetch(`/api/assistant/conversations/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: clean }),
      })
      if (!res.ok) throw new Error()
      setConvos((items) => renameConversationRow(items, id, clean))
    } catch {
      setError(t('errors.renameFailed'))
    }
  }

  async function doDelete(id: string) {
    setMenuFor(null)
    if (!(await confirmDialog({ message: t('deleteConfirm'), tone: 'danger' }))) return
    // Optimistic: the row leaves the sidebar now, and the tombstone lands
    // before the round-trip so a stale refetch or a remount served from a
    // prefetched payload cannot resurrect it while the DELETE is in flight.
    const at = convosRef.current.findIndex((c) => c.id === id)
    const snapshot = at >= 0 ? convosRef.current[at] : undefined
    rememberDeletedConversation(id)
    setConvos((items) => removeConversationRow(items, id))
    try {
      const res = await fetch(`/api/assistant/conversations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
    } catch {
      // Restore-on-failure: forget the tombstone first so the next sync or
      // refetch may show the row again, then splice it back where it was.
      forgetDeletedConversation(id)
      if (snapshot) {
        setConvos((items) => {
          if (items.some((c) => c.id === id)) return items
          const next = [...items]
          next.splice(Math.min(at, next.length), 0, snapshot)
          return next
        })
      }
      setError(t('errors.deleteFailed'))
      return
    }
    // Drop the provisional pin too, so the end-of-turn reconcile cannot
    // resurrect a thread the user just deleted.
    provisionalIdsRef.current.delete(id)
    // This conversation's turn state only: other in-flight turns are
    // untouched (different keys, different server runs).
    dropTurn(id)
    runIdsRef.current.delete(id)
    if (id === currentId) {
      router.push('/assistant')
    } else {
      startTransition(() => router.refresh())
    }
  }

  const suggestions = [
    t('suggestions.s1'),
    t('suggestions.s2'),
    t('suggestions.s3'),
    t('suggestions.s4'),
  ]

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="p-3">
        <Link href="/assistant" className="block">
          <Button variant="outline" className="w-full justify-start gap-2">
            <Plus className="h-4 w-4" />
            {t('newChat')}
          </Button>
        </Link>
      </div>
      <div className="app-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <div className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-slate-400 uppercase dark:text-slate-500">
          {t('history')}
        </div>
        {convos.length === 0 ? (
          <p className="px-2 py-1 text-xs text-slate-400 dark:text-slate-500">
            {t('noConversations')}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {convos.map((c) => {
              const active = c.id === currentId
              if (renamingId === c.id) {
                return (
                  <li key={c.id} className="px-1">
                    <input
                      autoFocus
                      defaultValue={c.title}
                      maxLength={TITLE_MAX_CHARS}
                      onBlur={(e) => void doRename(c.id, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter')
                          void doRename(c.id, (e.target as HTMLInputElement).value)
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="w-full rounded-md border border-teal-400 bg-white px-2 py-1.5 text-sm text-slate-900 focus:outline-none dark:bg-slate-950 dark:text-slate-100"
                    />
                  </li>
                )
              }
              return (
                <li key={c.id} className="group relative">
                  <Link
                    href={`/assistant/${c.id}`}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm',
                      active
                        ? 'bg-teal-50 text-teal-900 dark:bg-teal-950/50 dark:text-teal-100'
                        : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800',
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">{c.title}</span>
                  </Link>
                  <button
                    type="button"
                    onClick={() => setMenuFor(menuFor === c.id ? null : c.id)}
                    className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-1 text-slate-400 opacity-0 group-hover:opacity-100 hover:bg-slate-200 dark:hover:bg-slate-700"
                    aria-label={t('chatActions')}
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                  {menuFor === c.id ? (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />
                      <div className="absolute top-9 right-1 z-20 w-36 overflow-hidden rounded-lg border border-slate-200 bg-white py-1 shadow-lg dark:border-slate-700 dark:bg-slate-900">
                        <button
                          type="button"
                          onClick={() => {
                            setMenuFor(null)
                            setRenamingId(c.id)
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          {t('rename')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void doDelete(c.id)}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          {t('deleteChat')}
                        </button>
                      </div>
                    </>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Desktop sidebar */}
      <aside className="hidden w-72 shrink-0 border-r border-slate-200 bg-white lg:flex lg:flex-col dark:border-slate-800 dark:bg-slate-900">
        {sidebar}
      </aside>

      {/* Mobile sidebar drawer */}
      {sidebarOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 w-72 border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            {sidebar}
          </div>
        </div>
      ) : null}

      {/* Thread pane */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-slate-800 dark:bg-slate-900">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden dark:text-slate-400 dark:hover:bg-slate-800"
            aria-label={t('openHistory')}
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            <Sparkles className="h-4 w-4 text-teal-600 dark:text-teal-400" />
            {t('title')}
          </div>
        </header>

        <div ref={viewportRef} onScroll={onViewportScroll} className="app-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {hasOlder && messages.length > 0 ? (
              <div className="mb-4 flex justify-center">
                <button
                  type="button"
                  disabled={loadingOlder || streaming}
                  onClick={() => void loadOlder()}
                  className="rounded-md px-2.5 py-1 text-xs font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:cursor-wait disabled:text-slate-400 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
                >
                  {loadingOlder ? t('loadingEarlier') : t('loadEarlier')}
                </button>
              </div>
            ) : null}
            {visibleMessages.length === 0 ? (
              <Welcome
                suggestions={suggestions}
                onPick={(s) => void send(s)}
                canSend={aiEnabled}
                title={aiEnabled ? t('welcomeTitle') : t('notConfiguredTitle')}
                description={aiEnabled ? t('welcome') : t('errors.notConfigured')}
              />
            ) : (
              <div className="space-y-6">
                {visibleMessages.map((m, i) =>
                  m.role === 'system' ? null : (
                    <MessageRow
                      key={m.id}
                      message={m}
                      pending={streaming && m.role === 'assistant' && i === visibleMessages.length - 1}
                    />
                  ),
                )}
              </div>
            )}
            {(() => {
              const alert = liveError ?? error
              return alert ? (
                <div
                  role="alert"
                  className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
                >
                  {alert}
                </div>
              ) : null
            })()}
            {!stuckToBottom && visibleMessages.length > 0 ? (
              <div className="sticky bottom-4 flex justify-center">
                <button
                  type="button"
                  onClick={jumpToLatest}
                  aria-label={t('jumpToLatest')}
                  className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-600 shadow-md transition-colors hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800/95 dark:text-slate-300 dark:hover:bg-slate-700"
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                  {t('jumpToLatest')}
                </button>
              </div>
            ) : null}
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto w-full max-w-3xl">
            {!aiEnabled ? (
              <div className="space-y-3 py-2 text-center">
                {messages.length > 0 ? (
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t('errors.notConfigured')}
                  </p>
                ) : null}
                <div className="flex justify-center gap-2">
                  {canConfigureAi ? (
                    <Button asChild variant="outline">
                      <Link href="/admin/ai" target="_blank" rel="noopener noreferrer">
                        {admin('title')}
                      </Link>
                    </Button>
                  ) : null}
                  <Button variant="outline" onClick={() => router.refresh()}>
                    {common('refresh')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-1.5">
                {findingId ? (
                  <div className="flex items-center gap-2 rounded-xl border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs text-teal-900 dark:border-teal-900 dark:bg-teal-950/30 dark:text-teal-200">
                    <Sparkles className="h-3.5 w-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{t('context.attached')}</span>
                    <button
                      type="button"
                      onClick={() => setFindingId(null)}
                      className="shrink-0 rounded p-0.5 hover:bg-teal-100 dark:hover:bg-teal-900"
                      aria-label={t('context.remove')}
                      title={t('context.remove')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : null}
              <AssistantComposer
                streaming={streaming}
                sendLabel={t('send')}
                stopLabel={t('stop')}
                placeholder={t('placeholder')}
                onSend={sendToComposer}
                onStop={stop}
              />
              </div>
            )}
            {canWrite && aiEnabled ? (
              <p className="mt-1.5 text-center text-[11px] text-slate-400 dark:text-slate-500">
                {t('writeHint')}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The composer owns the draft input, so typing only re-renders this subtree.
 * Before, the input lived in AssistantApp state: every keystroke re-rendered
 * the whole panel, including every transcript row. On a long thread that meant
 * re-rendering every markdown/tool-card subtree per keystroke — typing lag
 * that grew with the conversation.
 */
const AssistantComposer = memo(function AssistantComposer({
  streaming,
  sendLabel,
  stopLabel,
  placeholder,
  onSend,
  onStop,
}: {
  streaming: boolean
  sendLabel: string
  stopLabel: string
  placeholder: string
  onSend: (text: string) => void
  onStop: () => void
}) {
  const [draft, setDraft] = useState('')
  function submitDraft(raw: string) {
    if (!raw.trim()) return
    onSend(raw)
    setDraft('')
  }
  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submitDraft(draft)
    }
  }
  return (
    <div className="flex items-center gap-1.5 rounded-2xl border border-slate-300 bg-white p-1.5 shadow-sm focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        maxLength={MAX_PROMPT_CHARS}
        rows={1}
        placeholder={placeholder}
        className="min-h-8 max-h-40 flex-1 resize-none appearance-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-base leading-5 text-slate-900 shadow-none outline-none [field-sizing:content] placeholder:text-slate-400 focus:border-0 focus:ring-0 focus:outline-none sm:text-sm dark:text-slate-100"
      />
      {streaming ? (
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-xl"
          onClick={onStop}
          aria-label={stopLabel}
        >
          <Square className="h-4 w-4" />
        </Button>
      ) : (
        <Button
          type="button"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-xl"
          onClick={() => submitDraft(draft)}
          disabled={!draft.trim()}
          aria-label={sendLabel}
        >
          <Send className="h-4 w-4" />
        </Button>
      )}
    </div>
  )
})

function MessageRow({ message, pending }: { message: ChatMessage; pending: boolean }) {
  const t = useTranslations('assistant')
  if (message.role === 'user') {
    const text = (
      message.parts.find((p) => (p as { type?: string })?.type === 'text') as
        | { text?: string }
        | undefined
    )?.text
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-teal-700 px-4 py-2 text-sm whitespace-pre-wrap text-white">
          {text}
        </div>
      </div>
    )
  }
  const empty = message.parts.length === 0
  return (
    <div className="assistant-message-row flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-sm">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        {empty && pending ? (
          <TypingIndicator label={t('responding')} />
        ) : (
          <MessageParts parts={message.parts} />
        )}
        {message.parts.length > 0 && pending ? (
          <div className="mt-2">
            <TypingIndicator label={t('responding')} />
          </div>
        ) : null}
        {message.createdAt && !pending ? (
          <MessageTimestamp value={message.createdAt} />
        ) : null}
      </div>
    </div>
  )
}

/**
 * Quiet chronology for a completed assistant turn. Stays in the
 * accessibility tree with the exact machine-readable instant, while the
 * compact label appears on row hover or keyboard focus. Small screens keep it
 * visible because touch has no dependable hover state.
 */
function MessageTimestamp({ value }: { value: string }) {
  const labels = formatMessageTimestamp(value)
  if (!labels) return null
  return (
    <time
      dateTime={value}
      title={labels.full}
      aria-label={labels.full}
      tabIndex={0}
      suppressHydrationWarning
      className="assistant-message-timestamp mt-1 block w-fit rounded-sm text-[11px] leading-4 tabular-nums text-slate-400 dark:text-slate-500"
    >
      {labels.compact}
    </time>
  )
}

/**
 * A self-contained streaming cue: three dots on the house cadence, still and
 * readable when the user requests reduced motion.
 */
function TypingIndicator({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex items-center gap-1 py-1.5">
      <style>{`
        @keyframes assistant-typing-dot {
          0%, 36%, 100% { opacity: 0.55; transform: translateY(0); }
          18% { opacity: 1; transform: translateY(-0.2rem); }
        }
        .assistant-typing-dot {
          animation: assistant-typing-dot 0.9s ease-out infinite;
          will-change: transform, opacity;
        }
        .assistant-message-timestamp { opacity: 1; }
        @media (min-width: 640px) {
          .assistant-message-timestamp { opacity: 0; }
          .assistant-message-row:hover .assistant-message-timestamp,
          .assistant-message-row:focus-within .assistant-message-timestamp,
          .assistant-message-timestamp:focus { opacity: 1; }
        }
        @media (prefers-reduced-motion: reduce) {
          .assistant-typing-dot { animation: none; opacity: 0.7; transform: none; will-change: auto; }
          .assistant-message-timestamp { transition: none; }
        }
      `}</style>
      {['0ms', '150ms', '300ms'].map((animationDelay) => (
        <span
          key={animationDelay}
          aria-hidden="true"
          className="assistant-typing-dot h-1.5 w-1.5 rounded-full bg-slate-400"
          style={{ animationDelay }}
        />
      ))}
    </div>
  )
}

function Welcome({
  suggestions,
  onPick,
  canSend,
  title,
  description,
}: {
  suggestions: string[]
  onPick: (t: string) => void
  canSend: boolean
  title: string
  description: string
}) {
  return (
    <div className="pt-10">
      <EmptyState icon={<Sparkles />} title={title} description={description} />
      {canSend ? (
        <div className="mx-auto mt-6 grid max-w-2xl gap-2 sm:grid-cols-2">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onPick(s)}
              className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-left text-sm text-slate-600 shadow-sm transition-colors hover:border-teal-300 hover:bg-teal-50/40 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-teal-800 dark:hover:bg-teal-950/30 dark:hover:text-slate-100"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
