import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import { haversineM } from '../../lib/geo';
import { formatCoord } from '../../lib/format';
import type { Position } from './types';

/**
 * Min jump distance (m) between two consecutive `currentPosition` updates
 * that triggers the camera to re-centre. Below this we keep the user's
 * pan/zoom intact — only teleports / large drifts grab focus.
 */
const AUTO_RECENTER_THRESHOLD_M = 500;

function currentPositionIcon(unsynced: boolean): L.DivIcon {
  const pinClasses = unsynced
    ? 'map-pin-current map-pin-current--unsynced'
    : 'map-pin-current';
  return L.divIcon({
    className: 'current-pos-marker',
    html: `<div data-fc="map.position-marker" class="${pinClasses}"></div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

/**
 * Owns the lifecycle of the current-position div-icon marker plus the
 * auto-recenter behaviour. Swaps the icon (not the marker) only when the
 * synced/unsynced state flips so tooltip bindings survive and the pulse
 * animation isn't restarted by every position update.
 *
 * Returns the prev-position ref so callers (the initial-position fetcher
 * inside the map-init effect) can detect whether a real device fix has
 * already arrived before applying their fallback view.
 */
export function useCurrentPositionMarker(
  mapRef: RefObject<L.Map | null>,
  currentPosition: Position | null,
  currentPositionUnsynced: boolean,
): RefObject<Position | null> {
  const markerRef = useRef<L.Marker | null>(null);
  const prevPositionRef = useRef<Position | null>(null);
  // Which unsynced state the marker's icon currently shows. `setIcon`
  // rewrites the icon's innerHTML, which restarts the pulse animation, so
  // it runs only when this flips — never on a plain position update.
  const iconUnsyncedRef = useRef<boolean | null>(null);
  // Latest flag for the marker-creation branch below, which must not list
  // it as a dep (that would re-run the position effect on a flip).
  const unsyncedRef = useRef(currentPositionUnsynced);
  useEffect(() => { unsyncedRef.current = currentPositionUnsynced; }, [currentPositionUnsynced]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!currentPosition) {
      if (markerRef.current) {
        try { markerRef.current.remove(); } catch { /* ignore */ }
        markerRef.current = null;
        iconUnsyncedRef.current = null;
      }
      prevPositionRef.current = null;
      return;
    }

    const latlng: L.LatLngExpression = [currentPosition.lat, currentPosition.lng];

    if (markerRef.current) {
      markerRef.current.setLatLng(latlng);
      markerRef.current.setTooltipContent(formatCoord(currentPosition));
    } else {
      const unsynced = unsyncedRef.current;
      const marker = L.marker(latlng, {
        icon: currentPositionIcon(unsynced),
        zIndexOffset: 1000,
      }).addTo(map);
      iconUnsyncedRef.current = unsynced;

      marker.bindTooltip(formatCoord(currentPosition), {
        direction: 'top',
        offset: [0, -20],
      });

      markerRef.current = marker;
    }

    const prev = prevPositionRef.current;
    if (!prev || haversineM(prev, currentPosition) > AUTO_RECENTER_THRESHOLD_M) {
      map.setView(latlng, map.getZoom());
    }
    prevPositionRef.current = currentPosition;
  }, [mapRef, currentPosition]);

  useEffect(() => {
    const marker = markerRef.current;
    if (!marker || iconUnsyncedRef.current === currentPositionUnsynced) return;
    marker.setIcon(currentPositionIcon(currentPositionUnsynced));
    iconUnsyncedRef.current = currentPositionUnsynced;
  }, [currentPositionUnsynced]);

  return prevPositionRef;
}
