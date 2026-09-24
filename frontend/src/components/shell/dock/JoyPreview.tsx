import { useCallback, useState } from 'react'
import { useSimActions } from '../../../contexts/SimContext'
import JoystickPad from '../../JoystickPad'

// Interactive joystick pad rendered in the dock-meta column when joystick
// mode is active. Drag or WASD/arrow keys → drives the device in real time
// (the underlying pad component owns input handling). Replaces what was
// previously a decorative SVG mock-up.
//
// The direction / intensity readout is local state: a drag re-renders only
// this pad, never the sim context or the app shell above it.
export default function JoyPreview() {
  const { joystickInput } = useSimActions()
  const [input, setInput] = useState({ direction: 0, intensity: 0 })

  const handleMove = useCallback((direction: number, intensity: number) => {
    // The readout shows whole percent, so round before storing to skip
    // re-renders that wouldn't change what's on screen.
    const pct = Math.round(Math.min(1, Math.max(0, intensity)) * 100) / 100
    setInput((prev) => (prev.direction === direction && prev.intensity === pct ? prev : { direction, intensity: pct }))
    joystickInput(direction, intensity)
  }, [joystickInput])
  const handleRelease = useCallback(() => handleMove(0, 0), [handleMove])

  return (
    <div className="mt-3.5 flex justify-center">
      <JoystickPad
        size={84}
        direction={input.direction}
        intensity={input.intensity}
        onMove={handleMove}
        onRelease={handleRelease}
      />
    </div>
  )
}
