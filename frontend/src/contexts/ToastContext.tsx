import React, { createContext, useContext, useState, useCallback, useRef, useMemo } from 'react'

interface ToastActions {
  showToast: (msg: string, ms?: number) => void
}

// Actions and the current message live in separate contexts: nearly every
// consumer only calls showToast, and must not re-render (or re-run effects
// keyed on the context value) each time a toast appears or clears.
const ToastActionsContext = createContext<ToastActions | null>(null)
const ToastMsgContext = createContext<string | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toastMsg, setToastMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const showToast = useCallback((msg: string, ms = 2000) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    setToastMsg(msg)
    timerRef.current = setTimeout(() => setToastMsg(null), ms)
  }, [])

  const actions = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastActionsContext.Provider value={actions}>
      <ToastMsgContext.Provider value={toastMsg}>
        {children}
      </ToastMsgContext.Provider>
    </ToastActionsContext.Provider>
  )
}

/** Stable `{ showToast }`; identity never changes for the provider's life. */
export function useToastContext() {
  const ctx = useContext(ToastActionsContext)
  if (!ctx) throw new Error('useToastContext must be used within ToastProvider')
  return ctx
}

/** The toast currently on screen (null when none). Re-renders on every change. */
export function useToastMsg() {
  return useContext(ToastMsgContext)
}
