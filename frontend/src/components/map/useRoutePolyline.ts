import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import { ACCENT_HEX } from '../../lib/constants';
import type { Position } from './types';

/**
 * Owns the dual-layer route polyline lifecycle: a wide faint glow plus a
 * thin dashed accent line with a CSS `route-line-flow` animation.
 *
 * Redraws on every new `routePath` array. The runtime keeps the same array
 * reference across position ticks, so a new reference means a new route
 * (re-sent, re-planned, or a different primary device); comparing only
 * length / start / end would miss routes that differ mid-way.
 *
 * ACCENT_HEX mirrors `--color-accent`; Leaflet writes it to an SVG
 * `stroke` attribute which doesn't resolve CSS vars.
 */
export function useRoutePolyline(
  mapRef: RefObject<L.Map | null>,
  routePath: Position[],
): void {
  const glowRef = useRef<L.Polyline | null>(null);
  const overlayRef = useRef<L.Polyline | null>(null);

  const removeLines = () => {
    glowRef.current?.remove();
    overlayRef.current?.remove();
    glowRef.current = null;
    overlayRef.current = null;
  };

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (routePath.length <= 1) {
      removeLines();
      return;
    }

    const latlngs: L.LatLngExpression[] = routePath.map((p) => [p.lat, p.lng]);

    if (glowRef.current && overlayRef.current) {
      glowRef.current.setLatLngs(latlngs);
      overlayRef.current.setLatLngs(latlngs);
      return;
    }

    glowRef.current = L.polyline(latlngs, {
      color: ACCENT_HEX,
      weight: 12,
      opacity: 0.08,
      lineCap: 'round',
      interactive: false,
    }).addTo(map);

    overlayRef.current = L.polyline(latlngs, {
      color: ACCENT_HEX,
      weight: 2.5,
      opacity: 0.95,
      dashArray: '6 8',
      lineCap: 'round',
      className: 'route-line-flow',
      interactive: false,
    }).addTo(map);
  }, [mapRef, routePath]);

  // Remove the lines only when the owning map unmounts.
  useEffect(() => removeLines, []);
}
