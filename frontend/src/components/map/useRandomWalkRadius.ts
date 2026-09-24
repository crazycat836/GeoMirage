import { useEffect, useRef, type RefObject } from 'react';
import L from 'leaflet';
import { DEVICE_COLORS_HEX } from '../../lib/constants';
import type { Position } from './types';

/**
 * Owns the dashed radius circle that visualises the random-walk
 * containment area (and the Loop / MultiStop waypoint-generation radius).
 * Drawn only when both a positive radius and a current position are
 * available; removed otherwise.
 *
 * While `pinCenter` is true the circle stays centred on the position it
 * had when `pinCenter` turned true: a running random walk picks every
 * target inside the radius around its start point (backend
 * core/random_walk.py), so a circle that followed the device would show
 * the wrong area. Otherwise it follows `currentPosition`.
 */
export function useRandomWalkRadius(
  mapRef: RefObject<L.Map | null>,
  randomWalkRadius: number | null,
  currentPosition: Position | null,
  pinCenter = false,
): void {
  const circleRef = useRef<L.Circle | null>(null);
  const pinnedCenterRef = useRef<Position | null>(null);

  const lat = currentPosition?.lat;
  const lng = currentPosition?.lng;

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    if (!pinCenter) pinnedCenterRef.current = null;
    else if (!pinnedCenterRef.current && lat != null && lng != null) {
      pinnedCenterRef.current = { lat, lng };
    }
    const center = pinCenter
      ? pinnedCenterRef.current
      : (lat != null && lng != null ? { lat, lng } : null);

    const visible = randomWalkRadius != null && randomWalkRadius > 0 && center != null;

    if (!visible) {
      if (circleRef.current) {
        circleRef.current.remove();
        circleRef.current = null;
      }
      return;
    }

    if (circleRef.current) {
      circleRef.current.setLatLng([center.lat, center.lng]);
      circleRef.current.setRadius(randomWalkRadius);
      return;
    }

    circleRef.current = L.circle([center.lat, center.lng], {
      radius: randomWalkRadius,
      color: DEVICE_COLORS_HEX[0],
      weight: 2,
      opacity: 0.6,
      fillColor: DEVICE_COLORS_HEX[0],
      fillOpacity: 0.08,
      dashArray: '6, 6',
    }).addTo(map);
  }, [mapRef, randomWalkRadius, lat, lng, pinCenter]);

  // Remove the circle on unmount only; position / radius changes above
  // update the existing circle in place.
  useEffect(() => () => {
    circleRef.current?.remove();
    circleRef.current = null;
  }, []);
}
