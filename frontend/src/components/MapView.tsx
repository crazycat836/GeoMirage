import { useRef, useEffect, useState, useCallback } from 'react';
import { useT } from '../i18n';
import { getInitialPosition } from '../services/api';
import L from 'leaflet';
import MapControls from './shell/MapControls';
import MapContextMenu, { type ContextMenuState } from './MapContextMenu';
import type { LeafletMapInternal, Position, Waypoint } from './map/types';
import { useCurrentPositionMarker } from './map/useCurrentPositionMarker';
import { usePcMarker } from './map/usePcMarker';
import { useDestinationMarker } from './map/useDestinationMarker';
import { useWaypointMarkers } from './map/useWaypointMarkers';
import { useRoutePolyline } from './map/useRoutePolyline';
import { useRandomWalkRadius } from './map/useRandomWalkRadius';
import { useFlowerCircles } from './map/useFlowerCircles';
import { useMapTiles } from './map/useMapTiles';

interface MapViewProps {
  currentPosition: Position | null;
  /** When true, renders the current-position pin in a "cached / not yet live"
   *  style (dashed outline, no pulse, no glow). Set while the frontend has
   *  rehydrated a last-known position from persisted settings but the
   *  backend engine has not yet been told about it this session. */
  currentPositionUnsynced?: boolean;
  destination: Position | null;
  waypoints: Waypoint[];
  routePath: Position[];
  /** Flower mode: circle radius drawn around every waypoint. Null hides
   *  the preview (any other mode). */
  flowerRadiusM?: number | null;
  randomWalkRadius: number | null;
  /** Keep the radius circle centred where it was when this turned true
   *  (a running random walk picks targets around its fixed start point)
   *  instead of following the current position. */
  randomWalkCenterPinned?: boolean;
  onMapClick: (lat: number, lng: number) => void;
  onTeleport: (lat: number, lng: number) => void;
  onNavigate: (lat: number, lng: number) => void;
  onAddBookmark: (lat: number, lng: number) => void;
  onAddWaypoint?: (lat: number, lng: number) => void;
  showWaypointOption?: boolean;
  /** Save the currently plotted route (its waypoints) from the right-click menu. */
  onSaveRoute?: () => void;
  showSaveRouteOption?: boolean;
  deviceConnected?: boolean;
  /** Open the device panel from the context menu's "no device" row. */
  onOpenDevices?: () => void;
  onShowToast?: (msg: string) => void;
  layerKey?: string;
  /** Fires once after Leaflet initializes so parents can drive imperative
   *  camera moves (fly-to, setView) without owning the instance. Called
   *  with null on unmount. */
  onMapReady?: (map: L.Map | null) => void;
  /** Physical PC geolocation pin — rendered as an amber dot with a pulsing
   *  halo so the user can see where the host computer actually is. Stays
   *  on the map until explicitly cleared (e.g. by "Refresh" in the Locate
   *  PC popover). Null/undefined removes the marker. */
  pcPosition?: Position | null;
}

function MapView({
  currentPosition,
  currentPositionUnsynced = false,
  destination,
  waypoints,
  routePath,
  flowerRadiusM = null,
  randomWalkRadius,
  randomWalkCenterPinned = false,
  onMapClick,
  onTeleport,
  onNavigate,
  onAddBookmark,
  onAddWaypoint,
  showWaypointOption,
  onSaveRoute,
  showSaveRouteOption,
  deviceConnected = true,
  onOpenDevices,
  onShowToast,
  layerKey = 'osm',
  onMapReady,
  pcPosition,
}: MapViewProps) {
  const t = useT();
  // onMapClick closure gets captured by the once-per-mount click handler;
  // route through a ref so toggling the prop mid-session takes effect.
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => { onMapClickRef.current = onMapClick; }, [onMapClick]);
  // onMapReady is invoked from both the init and the unmount-teardown
  // effect; routing through a ref means parents can re-render with a new
  // callback identity without retriggering either effect.
  const onMapReadyRef = useRef(onMapReady);
  useEffect(() => { onMapReadyRef.current = onMapReady; }, [onMapReady]);
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  // clickMarkerRef removed — left-click no longer drops a pin.

  // Tracks the ResizeObserver created during first-mount init so the
  // teardown effect can disconnect it on real unmount.
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    lat: 0,
    lng: 0,
  });

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  // Map init — runs exactly once on mount. Owns map creation, control-corner
  // offsets, click + contextmenu wiring, onMapReady fan-out, the
  // ResizeObserver, and the initial-position fetch. Tile-layer registry +
  // swap live in `useMapTiles` below; teardown lives in the next effect.
  useEffect(() => {
    if (mapRef.current || !mapContainerRef.current) return;

    const map = L.map(mapContainerRef.current, {
      center: [25.033, 121.5654],
      zoom: 13,
      zoomSnap: 1,
      wheelPxPerZoomLevel: 120,
      wheelDebounceTime: 60,
      // Keep Leaflet's default control off so we can position our own
      // zoom control below the EtaBar on the left (default top-left
      // would collide with the overlay).
      zoomControl: false,
    });
    // Nudge the whole topleft control cluster down below the FloatingPanel
    // (panel sits at top ~56px, ~320px tall max). Position below panel area.
    const mapInternal = map as LeafletMapInternal;
    const topLeftEl = mapInternal._controlCorners?.topleft;
    if (topLeftEl) {
      topLeftEl.style.marginTop = '56px';
      topLeftEl.style.marginLeft = '0px';
    }
    const topRightEl = mapInternal._controlCorners?.topright;
    if (topRightEl) {
      topRightEl.style.marginTop = '56px';
    }

    // Left-click on the map dismisses any open context menu.
    // If the parent wires `onMapClick` (currently used by the "left-click
    // to add waypoint" toggle in Loop / MultiStop modes), forward the
    // coordinates there too.
    map.on('click', (e: L.LeafletMouseEvent) => {
      closeContextMenu();
      try {
        onMapClickRef.current?.(e.latlng.lat, e.latlng.lng);
      } catch { /* ignore handler errors */ }
    });

    map.on('contextmenu', (e: L.LeafletMouseEvent) => {
      e.originalEvent.preventDefault();
      setContextMenu({
        visible: true,
        x: e.originalEvent.clientX,
        y: e.originalEvent.clientY,
        lat: e.latlng.lat,
        lng: e.latlng.lng,
      });
    });

    mapRef.current = map;
    onMapReadyRef.current?.(map);

    // Ensure the map fills its container after layout settles and on resize.
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
    });
    ro.observe(mapContainerRef.current);
    resizeObserverRef.current = ro;

    // Fetch the user-saved initial position from the backend (once, on mount).
    // If set, pan the map to it. Brief Taipei flash is acceptable.
    getInitialPosition().then(({ position }) => {
      if (!position || !mapRef.current) return;
      if (prevPositionRef.current) return; // a real device position already arrived
      mapRef.current.setView([position.lat, position.lng], mapRef.current.getZoom());
    }).catch(() => { /* default center stays */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useMapTiles(mapRef, layerKey);

  // Map teardown — separate from the layer-management effect so it fires
  // only on real unmount (not on every layerKey change). All dependencies
  // are refs, so this effect is genuinely empty-deps.
  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      mapRef.current?.remove();
      mapRef.current = null;
      onMapReadyRef.current?.(null);
    };
  }, []);

  const prevPositionRef = useCurrentPositionMarker(mapRef, currentPosition, currentPositionUnsynced);

  usePcMarker(mapRef, pcPosition);

  useDestinationMarker(mapRef, destination, t('map.destination'));

  useWaypointMarkers(mapRef, waypoints, t);

  useRoutePolyline(mapRef, routePath);

  useFlowerCircles(mapRef, waypoints, flowerRadiusM);

  useRandomWalkRadius(mapRef, randomWalkRadius, currentPosition, randomWalkCenterPinned);

  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map || !currentPosition) return;
    map.setView([currentPosition.lat, currentPosition.lng], Math.max(map.getZoom(), 16), {
      animate: true,
    });
  }, [currentPosition]);

  return (
    <div className="map-container" style={{ position: 'relative', flex: 1 }}>
      <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} />

      <MapControls
        onRecenter={recenter}
        onZoomIn={() => mapRef.current?.zoomIn()}
        onZoomOut={() => mapRef.current?.zoomOut()}
        canRecenter={!!currentPosition}
        className="absolute bottom-10 right-3 z-[var(--z-map-ui)]"
      />

      <MapContextMenu
        state={contextMenu}
        onClose={closeContextMenu}
        onTeleport={onTeleport}
        onNavigate={onNavigate}
        onAddBookmark={onAddBookmark}
        onAddWaypoint={onAddWaypoint}
        showWaypointOption={showWaypointOption}
        onSaveRoute={onSaveRoute}
        showSaveRouteOption={showSaveRouteOption}
        deviceConnected={deviceConnected}
        onOpenDevices={onOpenDevices}
        onShowToast={onShowToast}
      />
    </div>
  );
}

export default MapView;
