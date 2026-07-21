'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * Drawn-signature capture — a plain pointer-events canvas (mouse, touch, pen)
 * that exports a transparent PNG data-URL. Deliberately dependency-free.
 */
export function SignaturePad(props: {
  height?: number
  onChange: (dataUrl: string | null) => void
  clearLabel: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const drawing = useRef(false)
  const dirty = useRef(false)
  const [hasInk, setHasInk] = useState(false)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    // Match the backing store to the CSS size × devicePixelRatio for crisp ink.
    const scale = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * scale
    canvas.height = rect.height * scale
    const ctx = canvas.getContext('2d')!
    ctx.scale(scale, scale)
    ctx.lineWidth = 2
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.strokeStyle = '#0f172a'
  }, [])

  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drawing.current = true
    const ctx = e.currentTarget.getContext('2d')!
    const p = pos(e)
    ctx.beginPath()
    ctx.moveTo(p.x, p.y)
  }
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return
    const ctx = e.currentTarget.getContext('2d')!
    const p = pos(e)
    ctx.lineTo(p.x, p.y)
    ctx.stroke()
    dirty.current = true
    if (!hasInk) setHasInk(true)
  }
  const end = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawing.current = false
    if (dirty.current) props.onChange(e.currentTarget.toDataURL('image/png'))
  }

  const clear = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')!
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    dirty.current = false
    setHasInk(false)
    props.onChange(null)
  }

  return (
    <div className="space-y-1.5">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: props.height ?? 140, touchAction: 'none' }}
        className="rounded-md border border-dashed border-slate-300 bg-white dark:border-slate-600"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div className="flex justify-end">
        <button
          type="button"
          onClick={clear}
          disabled={!hasInk}
          className="text-xs text-slate-500 hover:text-slate-800 disabled:opacity-40 dark:hover:text-slate-200"
        >
          {props.clearLabel}
        </button>
      </div>
    </div>
  )
}
