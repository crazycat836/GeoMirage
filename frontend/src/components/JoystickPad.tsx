import React, { useRef, useState, useCallback, useEffect, useMemo } from 'react';
import { useT } from '../i18n';
import { hasOpenLayer } from '../hooks/useModalDismiss';

interface JoystickPadProps {
  direction: number;
  intensity: number;
  onMove: (direction: number, intensity: number) => void;
  onRelease: () => void;
  /** Outer pad diameter in pixels. Default 84 matches the dock-meta slot;
   *  callers wanting a larger overlay can pass e.g. 140. */
  size?: number;
}

const DEFAULT_SIZE = 84;
// Exponential-smoothing time constant for the visual handle. 40 ms gives a
// noticeably-smooth glide on keyboard/diagonal input without feeling sluggish
// under mouse drag (where the target updates per pointermove and so the
// visual tracks 1:1 anyway).
const SMOOTH_TAU_MS = 40;
const SETTLE_EPS = 0.05; // px — stop animating when both axes are within this

// Widgets that already use arrow keys (or letters) for their own navigation.
// While focus is inside one of these, WASD/arrows belong to that widget.
const KEY_OWNING_ROLES =
  '[role="menu"],[role="menubar"],[role="tablist"],[role="dialog"],[role="listbox"],[role="radiogroup"],[role="slider"]';

/** Whether a window-level keydown should be left alone by the joystick:
 *  modifier combos (Cmd+A/S/D), keys another handler already consumed,
 *  anything while a dialog/drawer/menu layer is open, and keys typed into
 *  form fields or widgets that navigate with arrows themselves. */
function shouldIgnoreJoystickKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return true;
  if (hasOpenLayer()) return true;
  const tgt = e.target;
  if (!(tgt instanceof HTMLElement)) return false;
  if (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.tagName === 'SELECT' || tgt.isContentEditable) {
    return true;
  }
  return tgt.closest(KEY_OWNING_ROLES) != null;
}

function JoystickPad({
  direction,
  intensity,
  onMove,
  onRelease,
  size = DEFAULT_SIZE,
}: JoystickPadProps) {
  const t = useT();
  const padRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  // Target is updated synchronously by pointer/keyboard input; the visual
  // handle position exponentially follows it inside a requestAnimationFrame
  // loop. Using a ref for the target avoids re-rendering on every input
  // event and lets the RAF loop always read the latest target.
  const targetPosRef = useRef({ x: 0, y: 0 });
  const [visualPos, setVisualPos] = useState({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);

  const { padRadius, handleRadius, maxDistance, frameSize } = useMemo(() => {
    const padR = size / 2;
    const handleR = Math.max(10, Math.round(size * 0.16));
    return {
      padRadius: padR,
      handleRadius: handleR,
      maxDistance: padR - handleR,
      // Frame leaves 25 px on each side for the compass labels around the pad.
      frameSize: size + 50,
    };
  }, [size]);

  // Kick the RAF loop whenever we set a new target. The loop self-terminates
  // once the visual settles onto the target to avoid burning cycles while idle.
  const ensureAnimating = useCallback(() => {
    if (rafRef.current !== null) return;
    lastTickRef.current = 0;
    const tick = (now: number) => {
      const dt = lastTickRef.current ? Math.min(now - lastTickRef.current, 100) : 16;
      lastTickRef.current = now;
      const alpha = 1 - Math.exp(-dt / SMOOTH_TAU_MS);
      // The updater MUST stay pure — under React.StrictMode (dev) it runs
      // twice, so scheduling the next RAF inside it would spawn two loops
      // per frame and double every tick until the tab freezes. We only
      // compute the next position here and decide whether we've settled
      // via a closure flag, then schedule (or stop) the RAF exactly once
      // outside the updater.
      let settled = false;
      setVisualPos((prev) => {
        const tx = targetPosRef.current.x;
        const ty = targetPosRef.current.y;
        const nx = prev.x + (tx - prev.x) * alpha;
        const ny = prev.y + (ty - prev.y) * alpha;
        if (Math.abs(tx - nx) < SETTLE_EPS && Math.abs(ty - ny) < SETTLE_EPS) {
          settled = true;
          return { x: tx, y: ty };
        }
        return { x: nx, y: ny };
      });
      if (settled) {
        rafRef.current = null;
      } else {
        rafRef.current = requestAnimationFrame(tick);
      }
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  const getDirectionLabel = (deg: number): string => {
    // deg is compass degrees: 0=N, 90=E, 180=S, 270=W
    const d = ((deg % 360) + 360) % 360;
    if (d >= 337.5 || d < 22.5) return t('joy.north');
    if (d >= 22.5 && d < 67.5) return t('joy.northeast');
    if (d >= 67.5 && d < 112.5) return t('joy.east');
    if (d >= 112.5 && d < 157.5) return t('joy.southeast');
    if (d >= 157.5 && d < 202.5) return t('joy.south');
    if (d >= 202.5 && d < 247.5) return t('joy.southwest');
    if (d >= 247.5 && d < 292.5) return t('joy.west');
    return t('joy.northwest');
  };

  const calcFromEvent = useCallback(
    (clientX: number, clientY: number) => {
      if (!padRef.current) return;
      const rect = padRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      const dx = clientX - centerX;
      const dy = -(clientY - centerY); // Invert Y for math coords

      const distance = Math.sqrt(dx * dx + dy * dy);
      const clampedDist = Math.min(distance, maxDistance);
      const normIntensity = clampedDist / maxDistance;

      // Convert to compass degrees: 0=N, 90=E, 180=S, 270=W
      // atan2(dx, dy) gives 0=N, π/2=E, matching compass convention
      const radians = Math.atan2(dx, dy);
      let compassDeg = (radians * 180) / Math.PI;
      if (compassDeg < 0) compassDeg += 360;

      // Clamp visual position to pad bounds so the handle sticks to the edge
      // when the cursor is dragged outside. Combined with pointer capture on
      // currentTarget (the pad itself, not just the handle), this keeps the
      // direction responsive even when the cursor leaves the pad area.
      const scale = distance > 0 ? clampedDist / distance : 0;
      targetPosRef.current = {
        x: dx * scale,
        y: -(dy * scale),
      };
      ensureAnimating();
      onMove(Math.round(compassDeg), normIntensity);
    },
    [onMove, ensureAnimating, maxDistance]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      setDragging(true);
      // Capture on currentTarget (the pad), NOT e.target. When the cursor
      // drifts onto the handle's inner <div> and then back out, capturing on
      // e.target can lose subsequent pointermove events. currentTarget is the
      // element the handler is bound to and is guaranteed to receive them.
      e.currentTarget.setPointerCapture(e.pointerId);
      calcFromEvent(e.clientX, e.clientY);
    },
    [calcFromEvent]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      calcFromEvent(e.clientX, e.clientY);
    },
    [dragging, calcFromEvent]
  );

  const handlePointerUp = useCallback(() => {
    setDragging(false);
    targetPosRef.current = { x: 0, y: 0 };
    ensureAnimating();
    onRelease();
  }, [onRelease, ensureAnimating]);

  // ── WASD / arrow keyboard control ───────────────────
  // Refs let the keyboard effect mount ONCE and still see fresh callback
  // identities on every render. Without these, an inline `onRelease` arrow
  // in the parent (which re-creates each render) would cause this effect
  // to tear down + re-attach listeners every WS tick — the `pressed` Set
  // would be wiped mid-keystroke and a held key's `keyup` would fire
  // against a fresh empty Set, never reaching `update()` → pad stuck.
  const onMoveRef = useRef(onMove);
  const onReleaseRef = useRef(onRelease);
  const maxDistanceRef = useRef(maxDistance);
  useEffect(() => { onMoveRef.current = onMove; }, [onMove]);
  useEffect(() => { onReleaseRef.current = onRelease; }, [onRelease]);
  useEffect(() => { maxDistanceRef.current = maxDistance; }, [maxDistance]);

  useEffect(() => {
    const pressed = new Set<string>();
    const KEY_DIR: Record<string, string> = {
      w: 'up', arrowup: 'up',
      s: 'down', arrowdown: 'down',
      a: 'left', arrowleft: 'left',
      d: 'right', arrowright: 'right',
    };

    const compute = () => {
      const up = pressed.has('up');
      const down = pressed.has('down');
      const left = pressed.has('left');
      const right = pressed.has('right');
      if (!up && !down && !left && !right) return null;

      let dx = 0, dy = 0;
      if (up) dy += 1;
      if (down) dy -= 1;
      if (right) dx += 1;
      if (left) dx -= 1;
      if (dx === 0 && dy === 0) return null;

      const rad = Math.atan2(dx, dy);
      let deg = (rad * 180) / Math.PI;
      if (deg < 0) deg += 360;
      return { deg: Math.round(deg), dx, dy };
    };

    const update = () => {
      const r = compute();
      if (!r) {
        setDragging(false);
        targetPosRef.current = { x: 0, y: 0 };
        ensureAnimating();
        onReleaseRef.current();
        return;
      }
      setDragging(true);
      onMoveRef.current(r.deg, 1);
      // Update the *target*; the RAF loop glides the visual handle from
      // its current position to the combined direction. Diagonal keypresses
      // (e.g. W+D) glide straight to NE instead of visibly stopping at N first.
      const len = Math.sqrt(r.dx * r.dx + r.dy * r.dy);
      const md = maxDistanceRef.current;
      targetPosRef.current = {
        x: (r.dx / len) * md,
        y: -(r.dy / len) * md,
      };
      ensureAnimating();
    };

    const releaseAll = () => {
      if (pressed.size > 0) {
        pressed.clear();
        setDragging(false);
        targetPosRef.current = { x: 0, y: 0 };
        ensureAnimating();
        onReleaseRef.current();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreJoystickKey(e)) return;
      const key = e.key.toLowerCase();
      const dir = KEY_DIR[key];
      if (!dir) return;
      e.preventDefault();
      if (!pressed.has(dir)) {
        pressed.add(dir);
        update();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      // macOS drops the keyup of any key released while Cmd is held, so a
      // direction pressed before/with Cmd would stay latched. Releasing
      // Cmd (or any keyup with Cmd still down) drops every held direction.
      if (e.key === 'Meta' || e.metaKey) { releaseAll(); return; }
      const key = e.key.toLowerCase();
      const dir = KEY_DIR[key];
      if (!dir) return;
      if (pressed.delete(dir)) update();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', releaseAll);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', releaseAll);
    };
    // Mount-once: callbacks are read via refs above so the listeners and
    // their `pressed` Set survive consumer re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensureAnimating]);

  // Compass direction labels around the pad.
  const arrows = [
    { deg: 0, label: t('joy.east'), x: padRadius + 20, y: 0 },
    { deg: 90, label: t('joy.north'), x: 0, y: -(padRadius + 20) },
    { deg: 180, label: t('joy.west'), x: -(padRadius + 20), y: 0 },
    { deg: 270, label: t('joy.south'), x: 0, y: padRadius + 20 },
  ];

  return (
    <div
      data-fc="dock.joystick"
      role="application"
      aria-label={t('joy.pad_aria_label')}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        userSelect: 'none',
        touchAction: 'none',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: frameSize,
          height: frameSize,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {arrows.map((a) => (
          <div
            key={a.label}
            style={{
              position: 'absolute',
              left: `calc(50% + ${a.x}px)`,
              top: `calc(50% + ${a.y}px)`,
              transform: 'translate(-50%, -50%)',
              fontSize: 11,
              fontWeight: 600,
              color: 'rgba(255,255,255,0.5)',
            }}
          >
            {a.label}
          </div>
        ))}

        <div
          ref={padRef}
          className="joystick-pad glass-pill-medium"
          style={{
            width: padRadius * 2,
            height: padRadius * 2,
            position: 'relative',
            cursor: dragging ? 'grabbing' : 'grab',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <svg
            width={padRadius * 2}
            height={padRadius * 2}
            viewBox={`0 0 ${padRadius * 2} ${padRadius * 2}`}
            style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
          >
            <line x1={padRadius} y1="10" x2={padRadius} y2={padRadius * 2 - 10} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <line x1="10" y1={padRadius} x2={padRadius * 2 - 10} y2={padRadius} stroke="rgba(255,255,255,0.08)" strokeWidth="1" />
            <circle cx={padRadius} cy={padRadius} r={padRadius - 5} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
            <circle cx={padRadius} cy={padRadius} r={maxDistance / 2} fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" strokeDasharray="4 4" />
          </svg>

          {/* Handle — positioned by the RAF smoothing loop, no CSS transition. */}
          <div
            className="joystick-handle"
            style={{
              width: handleRadius * 2,
              height: handleRadius * 2,
              borderRadius: '50%',
              background: dragging
                ? 'radial-gradient(circle, #6b8afd 0%, #4a6cf7 100%)'
                : 'radial-gradient(circle, #888 0%, #555 100%)',
              border: '2px solid rgba(255,255,255,0.3)',
              position: 'absolute',
              left: padRadius - handleRadius + visualPos.x,
              top: padRadius - handleRadius + visualPos.y,
              pointerEvents: 'none',
              boxShadow: dragging ? '0 0 12px rgba(74,108,247,0.5)' : '0 2px 6px rgba(0,0,0,0.3)',
            }}
          />
        </div>
      </div>

      <div
        className="glass-chip"
        style={{
          marginTop: 8,
          textAlign: 'center',
          fontSize: 12,
          padding: '4px 12px',
        }}
      >
        {intensity > 0.01 ? (
          <>
            {getDirectionLabel(direction)} | {(intensity * 100).toFixed(0)}%
          </>
        ) : (
          t('joy.drag_or_keys')
        )}
      </div>
    </div>
  );
}

export default JoystickPad;
