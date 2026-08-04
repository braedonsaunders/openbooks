'use client'

// The assistant experience, ported from beaconhs's AssistantApp: a
// multi-conversation sidebar + streaming thread with tool-use cards +
// composer. Streams via the UI-message protocol (readUIMessageStream) so the
// SAME parts[] renderer serves live tokens and reloaded transcripts.

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
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
  Loader2,
  Menu,
  MoreHorizontal,
  Pencil,
  Plus,
  Send,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react'
import { Button, EmptyState, cn } from '@openbooks/ui'
import { confirmDialog } from '@/lib/confirm'
import { MessageParts } from './message-parts'

type Role = 'user' | 'assistant' | 'system'
type ChatMessage = { id: string; role: Role; parts: unknown[] }

export type StoredMessage = {
  id: string
  role: Role
  content: string
  data: { parts?: unknown[] } | null
}

export type ConversationSummary = { id: string; title: string; updatedAt: string }

const MAX_PROMPT_CHARS = 32_000
const TITLE_MAX_CHARS = 120

export function toChatMessage(message: StoredMessage): ChatMessage {
  const storedParts = message.data?.parts
  return {
    id: message.id,
    role: message.role,
    parts:
      Array.isArray(storedParts) && storedParts.length > 0
        ? storedParts
        : [{ type: 'text', text: message.content }],
  }
}

function withLastAssistantParts(list: ChatMessage[], parts: unknown[]): ChatMessage[] {
  const copy = list.slice()
  for (let index = copy.length - 1; index >= 0; index -= 1) {
    const message = copy[index]
    if (message && message.role === 'assistant') {
      copy[index] = { ...message, parts }
      break
    }
  }
  return copy
}

export function AssistantApp({
  conversations,
  activeId,
  initialMessages,
  canWrite,
  aiEnabled,
  initialPrompt,
}: {
  conversations: ConversationSummary[]
  activeId: string | null
  initialMessages: StoredMessage[]
  canWrite: boolean
  aiEnabled: boolean
  /** Prompt passed via /assistant?q= (the ⌘K launcher); auto-sent once. */
  initialPrompt?: string
}) {
  const t = useTranslations('assistant')
  const router = useRouter()
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages.map(toChatMessage))
  const [convos, setConvos] = useState(conversations)
  const [currentId, setCurrentId] = useState<string | null>(activeId)
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const autoSentPrompt = useRef<string | null>(null)

  const scrollToBottom = useCallback(() => {
    window.requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ block: 'end' }))
  }, [])

  const refreshConversations = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/conversations')
      if (!res.ok) return
      const body = (await res.json()) as { items: ConversationSummary[] }
      setConvos(body.items)
    } catch {
      // best-effort — the sidebar simply stays stale
    }
  }, [])

  const send = useCallback(
    async (rawText: string) => {
      const text = rawText.trim()
      if (!text || text.length > MAX_PROMPT_CHARS || abortRef.current || !aiEnabled) return

      const conversationId = currentId
      let resolvedConversationId = conversationId
      const ac = new AbortController()
      abortRef.current = ac
      setError(null)
      setInput('')
      setSidebarOpen(false)
      const stamp = Date.now()
      setMessages((prev) => [
        ...prev,
        { id: `u-${stamp}`, role: 'user', parts: [{ type: 'text', text }] },
        { id: `a-${stamp}`, role: 'assistant', parts: [] },
      ])
      scrollToBottom()
      setStreaming(true)
      try {
        const res = await fetch('/api/assistant/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ conversationId, prompt: text }),
          signal: ac.signal,
        })
        const responseConversationId = res.headers.get('x-conversation-id')
        if (responseConversationId) {
          resolvedConversationId = responseConversationId
          setCurrentId(responseConversationId)
          if (!conversationId) {
            // Reflect the new thread in the URL without unmounting the stream.
            window.history.replaceState(null, '', `/assistant/${responseConversationId}`)
          }
        }
        if (!res.ok || !res.body) {
          setError(res.status === 503 ? t('errors.notConfigured') : t('errors.failed'))
          return
        }
        // The HTTP body is an SSE byte stream — parse it into UIMessageChunks
        // before handing it to readUIMessageStream (matches the SDK transport).
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
        let lastParts: unknown[] = []
        for await (const message of readUIMessageStream({ stream: chunkStream })) {
          lastParts = message.parts as unknown[]
          setMessages((prev) => withLastAssistantParts(prev, lastParts))
          scrollToBottom()
        }
        // A turn that ended without producing anything (e.g. the provider
        // rejected the request) would otherwise vanish silently.
        if (lastParts.length === 0 && !ac.signal.aborted) setError(t('errors.failed'))
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') setError(t('errors.failed'))
      } finally {
        if (!resolvedConversationId) {
          // The turn never started server-side — drop the optimistic bubbles.
          setMessages((prev) =>
            prev.filter((message) => message.id !== `u-${stamp}` && message.id !== `a-${stamp}`),
          )
        } else if (ac.signal.aborted) {
          // Reconcile with what actually got persisted for the stopped turn.
          await new Promise((resolve) => window.setTimeout(resolve, 150))
          try {
            const res = await fetch(`/api/assistant/conversations/${resolvedConversationId}`)
            if (res.ok) {
              const body = (await res.json()) as { messages: StoredMessage[] }
              setMessages(body.messages.map(toChatMessage))
            }
          } catch {
            // keep the streamed state
          }
        }
        setStreaming(false)
        if (abortRef.current === ac) abortRef.current = null
        void refreshConversations()
      }
    },
    [aiEnabled, currentId, refreshConversations, scrollToBottom, t],
  )

  // Auto-send a prompt passed via ?q= (from the ⌘K launcher) once per distinct
  // query. Wait for any active turn to finish so navigation cannot drop it.
  useEffect(() => {
    const prompt = initialPrompt?.trim()
    if (!prompt || !aiEnabled || streaming || abortRef.current || autoSentPrompt.current === prompt) {
      return
    }
    autoSentPrompt.current = prompt
    void send(prompt)
  }, [aiEnabled, initialPrompt, send, streaming])

  function stop() {
    abortRef.current?.abort()
  }

  function onComposerKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send(input)
    }
  }

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
      setConvos((items) => items.map((c) => (c.id === id ? { ...c, title: clean } : c)))
    } catch {
      setError(t('errors.renameFailed'))
    }
  }

  async function doDelete(id: string) {
    setMenuFor(null)
    if (!(await confirmDialog({ message: t('deleteConfirm'), tone: 'danger' }))) return
    try {
      const res = await fetch(`/api/assistant/conversations/${id}`, { method: 'DELETE' })
      if (!res.ok) throw new Error()
      setConvos((items) => items.filter((c) => c.id !== id))
      if (id === currentId) {
        router.push('/assistant')
      } else {
        startTransition(() => router.refresh())
      }
    } catch {
      setError(t('errors.deleteFailed'))
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

        <div className="app-scroll min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-6">
            {messages.length === 0 ? (
              <Welcome
                suggestions={suggestions}
                onPick={(s) => void send(s)}
                canSend={aiEnabled}
                title={aiEnabled ? t('welcomeTitle') : t('notConfiguredTitle')}
                description={aiEnabled ? t('welcome') : t('errors.notConfigured')}
              />
            ) : (
              <div className="space-y-6">
                {messages.map((m) =>
                  m.role === 'system' ? null : (
                    <MessageRow key={m.id} message={m} streaming={streaming} />
                  ),
                )}
              </div>
            )}
            {error ? (
              <div
                role="alert"
                className="mt-5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-300"
              >
                {error}
              </div>
            ) : null}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Composer */}
        <div className="shrink-0 border-t border-slate-200 bg-white px-4 py-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="mx-auto w-full max-w-3xl">
            {!aiEnabled ? (
              <p className="py-2 text-center text-sm text-slate-500 dark:text-slate-400">
                {t('errors.notConfigured')}
              </p>
            ) : (
              <div className="flex items-center gap-1.5 rounded-2xl border border-slate-300 bg-white p-1.5 shadow-sm focus-within:border-teal-500 focus-within:ring-2 focus-within:ring-teal-500/20 dark:border-slate-700 dark:bg-slate-950">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onComposerKey}
                  maxLength={MAX_PROMPT_CHARS}
                  rows={1}
                  placeholder={t('placeholder')}
                  className="min-h-8 max-h-40 flex-1 resize-none appearance-none overflow-y-auto border-0 bg-transparent px-2 py-1.5 text-base leading-5 text-slate-900 shadow-none outline-none [field-sizing:content] placeholder:text-slate-400 focus:border-0 focus:ring-0 focus:outline-none sm:text-sm dark:text-slate-100"
                />
                {streaming ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-xl"
                    onClick={stop}
                    aria-label={t('stop')}
                  >
                    <Square className="h-4 w-4" />
                  </Button>
                ) : (
                  <Button
                    type="button"
                    size="icon"
                    className="h-8 w-8 shrink-0 rounded-xl"
                    onClick={() => void send(input)}
                    disabled={!input.trim()}
                    aria-label={t('send')}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                )}
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

function MessageRow({ message, streaming }: { message: ChatMessage; streaming: boolean }) {
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
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-teal-500 to-teal-700 text-white shadow-sm">
        <Sparkles className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        {empty && streaming ? <ThinkingDots /> : <MessageParts parts={message.parts} />}
      </div>
    </div>
  )
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-1.5 text-slate-400">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-400"
          style={{ animationDelay: `${i * 0.15}s` }}
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
