'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { X } from 'lucide-react'
import { cn } from '@openbooks/ui'

/**
 * The house first-run wizard chrome — the full-screen scrim, centered modal
 * card, segmented progress bar, animated step transitions, and the
 * back / primary footer — extracted verbatim from the org onboarding
 * SetupWizard so every module wizard (payroll onboarding, …) IS the same
 * stepper rather than a lookalike. Step CONTENT stays with the caller; this
 * component owns only the composition.
 */
export function WizardShell(props: {
  testId: string
  /** Key of the current step — drives the AnimatePresence transition. */
  stepKey: string
  /** Segmented progress bar; null hides it (welcome / applying / done). */
  progress: { index: number; total: number } | null
  /** Top-right skip/close affordance; null hides it (applying / done). */
  skip: { label: React.ReactNode; onClick: () => void; disabled?: boolean } | null
  /** Footer navigation; null hides it (applying / done). */
  footer: {
    back: { label: React.ReactNode; onClick: () => void; disabled?: boolean } | null
    primary: { label: React.ReactNode; onClick: () => void; disabled?: boolean }
  } | null
  children: React.ReactNode
}) {
  const reduceMotion = useReducedMotion()
  return (
    <AnimatePresence>
      <motion.div
        initial={reduceMotion ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduceMotion ? undefined : { opacity: 0 }}
        transition={{ duration: 0.2 }}
        data-testid={props.testId}
        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/80 backdrop-blur-sm"
      >
        {props.skip && (
          <button
            type="button"
            onClick={props.skip.onClick}
            disabled={props.skip.disabled}
            className="absolute right-6 top-6 z-10 flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X size={16} /> {props.skip.label}
          </button>
        )}

        <motion.div
          initial={reduceMotion ? false : { scale: 0.95, y: 10 }}
          animate={{ scale: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 300, damping: 30 }}
          className="relative flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-slate-900"
        >
          {props.progress && (
            <div className="flex items-center gap-2 px-6 pt-5">
              {Array.from({ length: props.progress.total }, (_, i) => (
                <div
                  key={i}
                  className={cn(
                    'h-1.5 flex-1 rounded-full transition-colors duration-300',
                    i <= props.progress!.index ? 'bg-teal-500' : 'bg-slate-200 dark:bg-slate-700',
                  )}
                />
              ))}
            </div>
          )}

          {/* Step content (scrollable) */}
          <div className="flex-1 overflow-y-auto px-6 py-6 sm:px-10 sm:py-8">
            <AnimatePresence mode="wait">
              <motion.div
                key={props.stepKey}
                initial={reduceMotion ? false : { opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={reduceMotion ? undefined : { opacity: 0, x: -20 }}
                transition={{ duration: 0.25 }}
              >
                {props.children}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer navigation */}
          {props.footer && (
            <div className="flex items-center justify-between border-t border-slate-200 px-6 py-4 dark:border-slate-800 sm:px-10">
              {props.footer.back ? (
                <button
                  type="button"
                  onClick={props.footer.back.onClick}
                  disabled={props.footer.back.disabled}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 disabled:opacity-50 dark:text-slate-300 dark:hover:bg-slate-800"
                >
                  {props.footer.back.label}
                </button>
              ) : (
                <span aria-hidden="true" />
              )}
              <button
                type="button"
                onClick={props.footer.primary.onClick}
                disabled={props.footer.primary.disabled}
                className="flex items-center gap-1.5 rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {props.footer.primary.label}
              </button>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
