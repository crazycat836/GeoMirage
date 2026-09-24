import { useEffect, useCallback, useRef } from 'react'

interface JoystickInput {
  direction: number
  intensity: number
  sensitivity?: number
}

/** Minimum gap between two `joystick_input` frames. The backend joystick
 *  loop only reads the latest input every 80 ms (core/joystick.py), so
 *  sending faster than this is pure overhead; 50 ms caps a drag at 20
 *  frames per second and still lands a fresh value in every backend tick. */
export const JOYSTICK_SEND_INTERVAL_MS = 50

/** Intensity is sent rounded to this many decimals so sub-pixel pointer
 *  jitter doesn't count as a change. */
const INTENSITY_DECIMALS = 2

/**
 * Forwards joystick input from the pad to the backend over WebSocket.
 *
 * Holds no React state: the pad renders its own direction / intensity
 * readout, so a drag never re-renders the sim context or anything above
 * the pad. Sends are throttled to one per `JOYSTICK_SEND_INTERVAL_MS`
 * (the latest value wins), unchanged input is dropped, and a release
 * (intensity 0) goes out immediately so the device stops without delay.
 */
export function useJoystick(
  sendWsMessage: (type: string, data: JoystickInput) => void,
  active: boolean,
  sensitivity = 1,
) {
  const sendRef = useRef(sendWsMessage)
  // Track sensitivity in a ref so the latest value rides along with each
  // input without re-creating the (stable) updateFromPad callback.
  const sensitivityRef = useRef(sensitivity)
  const lastSentRef = useRef<{ direction: number; intensity: number } | null>(null)
  const lastSentAtRef = useRef(-Infinity)
  const pendingRef = useRef<{ direction: number; intensity: number } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    sendRef.current = sendWsMessage
  }, [sendWsMessage])
  useEffect(() => {
    sensitivityRef.current = sensitivity
  }, [sensitivity])

  const clearPending = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    pendingRef.current = null
  }, [])

  const send = useCallback((direction: number, intensity: number) => {
    const last = lastSentRef.current
    if (last && last.direction === direction && last.intensity === intensity) return
    lastSentRef.current = { direction, intensity }
    lastSentAtRef.current = Date.now()
    sendRef.current('joystick_input', {
      direction,
      intensity,
      sensitivity: sensitivityRef.current,
    })
  }, [])

  // Reset when joystick mode exits, so a re-entry starts clean and a
  // trailing send can't fire after the mode is gone.
  useEffect(() => {
    if (!active) {
      clearPending()
      lastSentRef.current = null
    }
  }, [active, clearPending])

  useEffect(() => clearPending, [clearPending])

  // JoystickPad owns the keyboard + pointer input. We just receive
  // normalized (direction, intensity) updates here and fan them out via
  // WS. A duplicate window keyboard listener here would make every WASD
  // press emit twice.
  const updateFromPad = useCallback(
    (dir: number, int: number) => {
      const factor = 10 ** INTENSITY_DECIMALS
      const intensity = Math.round(Math.min(1, Math.max(0, int)) * factor) / factor
      if (intensity === 0) {
        clearPending()
        send(dir, 0)
        return
      }
      const wait = JOYSTICK_SEND_INTERVAL_MS - (Date.now() - lastSentAtRef.current)
      if (wait <= 0 && timerRef.current === null) {
        send(dir, intensity)
        return
      }
      pendingRef.current = { direction: dir, intensity }
      if (timerRef.current === null) {
        timerRef.current = setTimeout(() => {
          timerRef.current = null
          const p = pendingRef.current
          pendingRef.current = null
          if (p) send(p.direction, p.intensity)
        }, Math.max(0, wait))
      }
    },
    [send, clearPending],
  )

  return { updateFromPad }
}
