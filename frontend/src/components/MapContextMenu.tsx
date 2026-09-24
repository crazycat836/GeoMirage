import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useT } from '../i18n';
import { reverseGeocode } from '../services/api';
import { copyToClipboard } from '../lib/clipboard';
import { formatCoord } from '../lib/format';
import { focusFirstMenuItem, handleMenuArrowKeys } from '../lib/menu-keys';
import { useModalDismiss } from '../hooks/useModalDismiss';

export interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  lat: number;
  lng: number;
}

interface WhatsHereState {
  loading: boolean;
  label: string;
  address: string;
  error: boolean;
}

const WHATS_HERE_IDLE: WhatsHereState = { loading: false, label: '', address: '', error: false };

interface MapContextMenuProps {
  state: ContextMenuState;
  onClose: () => void;
  onTeleport: (lat: number, lng: number) => void;
  onNavigate: (lat: number, lng: number) => void;
  onAddBookmark: (lat: number, lng: number) => void;
  onAddWaypoint?: (lat: number, lng: number) => void;
  showWaypointOption?: boolean;
  /** Save the route currently plotted in the sim (its waypoints). */
  onSaveRoute?: () => void;
  /** Show the "Save route" item — true only when there's a route to save. */
  showSaveRouteOption?: boolean;
  deviceConnected: boolean;
  /** Open the device panel — used by the "no device" row so it's an
   *  actionable shortcut instead of a dead, USB-specific label. */
  onOpenDevices?: () => void;
  onShowToast?: (msg: string) => void;
}

/**
 * Right-click context menu for the Leaflet map. Hosts the "What's here?"
 * reverse-geocode flow and the device-gated teleport / navigate / bookmark /
 * add-waypoint actions. Self-contained: owns its viewport-clamp measurement
 * effect and outside-click dismissal so MapView only needs to track the
 * trigger state.
 */
function MapContextMenu({
  state,
  onClose,
  onTeleport,
  onNavigate,
  onAddBookmark,
  onAddWaypoint,
  showWaypointOption,
  onSaveRoute,
  showSaveRouteOption,
  deviceConnected,
  onOpenDevices,
  onShowToast,
}: MapContextMenuProps) {
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;

  // Measured-and-clamped menu position. Null while the menu is hidden or
  // before useLayoutEffect has run once; the menu is rendered invisibly on
  // first frame to measure, then re-rendered at the clamped position.
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [whatsHere, setWhatsHere] = useState<WhatsHereState>(WHATS_HERE_IDLE);
  // Token bumped each time we want to invalidate any in-flight
  // reverseGeocode resolution — the awaited callback compares its
  // captured token against the live ref and bails when they differ.
  // Bumped on close (via the reset effect below) and on a new click.
  const whatsHereTokenRef = useRef(0);

  // Reset transient menu state when the menu hides.
  useEffect(() => {
    if (!state.visible) {
      whatsHereTokenRef.current += 1;
      setMenuPos(null);
      setWhatsHere(WHATS_HERE_IDLE);
    }
  }, [state.visible]);

  // Close context menu on outside click. Registering on the next tick
  // (setTimeout 0) avoids the right-click that opened the menu from
  // immediately auto-closing it — some browsers synthesize a `click`
  // right after `contextmenu`, and that synthetic event would bubble
  // to `document` before the user ever sees the menu. Same pattern
  // used by DevicesPopover's outside-click effect.
  useEffect(() => {
    if (!state.visible) return;
    const handler = () => onClose();
    const tid = setTimeout(() => {
      document.addEventListener('click', handler);
    }, 0);
    return () => {
      clearTimeout(tid);
      document.removeEventListener('click', handler);
    };
  }, [state.visible, onClose]);

  // Esc closes the menu through the shared layer stack, so it only closes
  // this menu (not a surface underneath) and focus returns to where it was.
  useModalDismiss({ open: state.visible, onDismiss: onClose });

  // Move focus into the menu once it has been measured and made visible
  // (a `visibility: hidden` element can't take focus).
  const menuShown = menuPos != null;
  useEffect(() => {
    if (menuShown) focusFirstMenuItem(menuRef.current);
  }, [menuShown]);

  // Clamp the context menu to the viewport. Running in useLayoutEffect lets
  // us measure the real DOM before the browser paints, so the menu doesn't
  // visibly flash in the clipped position before jumping back in-bounds.
  useLayoutEffect(() => {
    if (!state.visible) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pad = 8;
    const maxLeft = window.innerWidth - rect.width - pad;
    const maxTop = window.innerHeight - rect.height - pad;
    const left = Math.max(pad, Math.min(state.x, maxLeft));
    const top = Math.max(pad, Math.min(state.y, maxTop));
    setMenuPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
    // Re-measure when the "What's here" panel expands/collapses — its
    // content changes the menu's height so we need to re-clamp. whatsHere
    // is referenced so the effect re-runs on every transition.
  }, [state.visible, state.x, state.y, whatsHere.loading, whatsHere.label, whatsHere.address, whatsHere.error]);

  const handleWhatsHere = useCallback(async () => {
    const lat = state.lat;
    const lng = state.lng;
    // Bump + capture; if the menu closes (or the user clicks again)
    // before we resolve, the captured token won't match the live ref
    // and we skip the setWhatsHere — preventing stray updates after
    // the menu has been dismissed.
    whatsHereTokenRef.current += 1;
    const token = whatsHereTokenRef.current;
    setWhatsHere({ loading: true, label: '', address: '', error: false });
    try {
      const res = await reverseGeocode(lat, lng);
      if (whatsHereTokenRef.current !== token) return;
      if (!res) {
        setWhatsHere({ loading: false, label: '', address: '', error: true });
        return;
      }
      setWhatsHere({
        loading: false,
        label: res.place_name || res.display_name || '',
        address: res.display_name || '',
        error: false,
      });
    } catch {
      if (whatsHereTokenRef.current !== token) return;
      setWhatsHere({ loading: false, label: '', address: '', error: true });
    }
  }, [state.lat, state.lng]);

  if (!state.visible) return null;

  return (
    <div
      data-fc="map.context-menu"
      ref={menuRef}
      className="context-menu anim-scale-in-tl"
      role="menu"
      aria-label={formatCoord(state)}
      onKeyDown={(e) => handleMenuArrowKeys(e, menuRef.current)}
      style={{
        // On first render we haven't measured yet; hide the menu so the
        // user doesn't see it flash at an out-of-bounds location before
        // useLayoutEffect clamps it. Once measured, render at clamped
        // position and make visible.
        left: menuPos?.left ?? state.x,
        top: menuPos?.top ?? state.y,
        visibility: menuPos ? 'visible' : 'hidden',
      }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 1. Coordinates label — clickable. Tapping it reverse-geocodes
            and expands the human-readable address inline underneath,
            so the user can sanity-check "where is this?" before
            choosing teleport / navigate. */}
      <button
        type="button"
        role="menuitem"
        className="font-mono"
        onClick={handleWhatsHere}
        disabled={whatsHere.loading}
        style={{
          all: 'unset',
          boxSizing: 'border-box',
          width: '100%',
          padding: '8px 16px 6px',
          color: 'var(--color-accent-strong)',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          userSelect: 'text',
          cursor: whatsHere.loading ? 'progress' : 'pointer',
        }}
        title={tRef.current('map.whats_here')}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ opacity: 0.7, flexShrink: 0 }}>
          <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z" />
          <circle cx="12" cy="10" r="3" />
        </svg>
        <span>{formatCoord(state)}</span>
      </button>
      {whatsHere.loading && (
        <div style={{ padding: '0 16px 6px', fontSize: 11, opacity: 0.7, fontStyle: 'italic' }}>
          {tRef.current('map.whats_here_loading')}
        </div>
      )}
      {!whatsHere.loading && whatsHere.error && (
        <div style={{ padding: '0 16px 6px', fontSize: 11, color: 'var(--color-danger)' }}>
          {tRef.current('map.whats_here_failed')}
        </div>
      )}
      {!whatsHere.loading && !whatsHere.error && whatsHere.label && (
        <div style={{ padding: '0 16px 6px', fontSize: 11, color: 'var(--color-text-1)' }}>
          <div style={{ fontWeight: 600 }}>{whatsHere.label}</div>
          {whatsHere.address && whatsHere.address !== whatsHere.label && (
            <div style={{ opacity: 0.7, marginTop: 2, lineHeight: 1.35 }}>{whatsHere.address}</div>
          )}
        </div>
      )}
      <div role="separator" style={{ height: 1, background: 'var(--color-border)', margin: '2px 0 4px' }} />

      {/* 2 + 3. Teleport / Navigate (device-gated). */}
      {deviceConnected ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            style={contextMenuItemStyle}
            onClick={() => {
              onTeleport(state.lat, state.lng);
              onClose();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
            </svg>
            {t('map.teleport_here')}
          </button>
          <button
            type="button"
            role="menuitem"
            className="context-menu-item"
            style={contextMenuItemStyle}
            onClick={() => {
              onNavigate(state.lat, state.lng);
              onClose();
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
              <polygon points="3,11 22,2 13,21 11,13" />
            </svg>
            {t('map.navigate_here')}
          </button>
        </>
      ) : (
        <button
          type="button"
          role="menuitem"
          className="context-menu-item"
          style={{ ...contextMenuItemStyle, color: 'var(--color-danger-text)', cursor: onOpenDevices ? 'pointer' : 'default' }}
          disabled={!onOpenDevices}
          onClick={() => {
            if (!onOpenDevices) return;
            onOpenDevices();
            onClose();
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          {t('map.device_disconnected')}
        </button>
      )}

      {/* 4. Copy coordinates to clipboard. */}
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        style={contextMenuItemStyle}
        onClick={async () => {
          const txt = formatCoord(state);
          await copyToClipboard(txt);
          if (onShowToast) onShowToast(tRef.current('map.coords_copied'));
          onClose();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
        {t('map.copy_coords')}
      </button>

      {/* 5. Add to bookmarks. */}
      <button
        type="button"
        role="menuitem"
        className="context-menu-item"
        style={contextMenuItemStyle}
        onClick={() => {
          onAddBookmark(state.lat, state.lng);
          onClose();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
          <path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z" />
        </svg>
        {t('map.add_bookmark')}
      </button>

      {/* 6. Route actions — add waypoint (route modes) + save the current
            route. Grouped under one separator; the separator only renders
            when at least one of the two is available. */}
      {((showWaypointOption && onAddWaypoint) || (showSaveRouteOption && onSaveRoute)) && (
        <div role="separator" style={{ height: 1, background: 'var(--color-border-strong)', margin: '4px 0' }} />
      )}
      {showWaypointOption && onAddWaypoint && (
        <button
          type="button"
          role="menuitem"
          className="context-menu-item"
          style={contextMenuItemStyle}
          onClick={() => {
            onAddWaypoint(state.lat, state.lng);
            onClose();
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8 }}>
            <circle cx="12" cy="12" r="3" />
            <line x1="12" y1="5" x2="12" y2="1" />
            <line x1="12" y1="23" x2="12" y2="19" />
            <line x1="5" y1="12" x2="1" y2="12" />
            <line x1="23" y1="12" x2="19" y2="12" />
          </svg>
          {t('map.add_waypoint')}
        </button>
      )}
      {showSaveRouteOption && onSaveRoute && (
        <button
          type="button"
          role="menuitem"
          className="context-menu-item"
          style={contextMenuItemStyle}
          onClick={() => {
            onSaveRoute();
            onClose();
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: 8 }}>
            <circle cx="6" cy="19" r="3" />
            <path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15" />
            <circle cx="18" cy="5" r="3" />
          </svg>
          {t('route.quick_save')}
        </button>
      )}
    </div>
  );
}

// Per-row layout overrides only. Hover state lives in `.context-menu-item:hover`
// (legacy.css) — keeping it in CSS lets us drop the JS mouse-enter / mouse-leave
// handlers that were both redundant and clobbering the CSS `:hover` rule with
// an inline `style.background`.
const contextMenuItemStyle: React.CSSProperties = {
  padding: '8px 16px',
};

export default MapContextMenu;
