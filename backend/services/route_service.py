"""OSRM route planning service."""

from __future__ import annotations

import asyncio
import logging
import time

import httpx

from config import OSRM_BASE_URL, SPEED_PROFILES
from services.http_client import make_async_client_singleton
from utils.geo import haversine_m

logger = logging.getLogger(__name__)

# Map user-facing profile names to OSRM profile slugs
_PROFILE_MAP = {
    "walking": "foot",
    "running": "foot",
    "driving": "car",
    "foot": "foot",
    "car": "car",
    "bike": "bike",
    "bicycle": "bicycle",
}

_TIMEOUT = httpx.Timeout(8.0, connect=4.0)


class RouteUnavailableError(RuntimeError):
    """OSRM could not produce a road route.

    Raised after transport retries and (for multi-via requests) the
    per-leg fallback are exhausted. Callers abort the run and surface
    the message — routes must never silently degrade to straight lines;
    only the user's explicit ``force_straight`` toggle does that.

    ``code`` is the stable machine-readable tag the API layer forwards to
    the frontend (mirrors ``api._errors.ErrorCode.ROUTE_UNAVAILABLE``;
    kept as a plain string so services stay independent of the API layer).
    """

    code = "route_unavailable"


class RouteServiceUnreachableError(RouteUnavailableError):
    """OSRM itself could not be reached (transport failure / 5xx, or a
    region already marked down) — as opposed to OSRM answering that no
    road route exists between two specific points. Retrying with other
    points cannot help, so modes that skip unroutable destinations still
    abort on this one."""


class _OsrmRejected(Exception):
    """OSRM was reachable but refused this specific request (HTTP 4xx or
    a logical error such as ``NoRoute``/``NoSegment`` in a 200 body).
    Internal signal — multi-via callers retry leg-by-leg before giving up.
    """


# Lifespan-scoped HTTP client. Reusing the connection pool avoids the
# TCP+TLS handshake on every OSRM call — multi-stop with 10+ legs would
# otherwise pay it once per leg. Closed on FastAPI shutdown.
_get_client, close_client = make_async_client_singleton(_TIMEOUT)


def _straight_line_fallback(
    waypoints: list[tuple[float, float]],
    walking_speed_mps: float | None = None,
) -> dict:
    """Construct a straight-line route as a last resort when OSRM is unreachable.
    Densifies each segment so the interpolator has enough sample points.

    ``walking_speed_mps=None`` resolves to ``SPEED_PROFILES["walking"]
    ["speed_mps"]`` at call time. Resolving inside the body (rather than
    in the default expression) keeps the function decoupled from
    import-time evaluation order — the speed profile is read fresh on
    every call, so test overrides and config reloads take effect.
    """
    if walking_speed_mps is None:
        walking_speed_mps = SPEED_PROFILES["walking"]["speed_mps"]
    coords: list[list[float]] = [[waypoints[0][0], waypoints[0][1]]]
    total_distance = 0.0
    leg_durations: list[float] = []
    step_m = 25.0
    for i in range(len(waypoints) - 1):
        a_lat, a_lng = waypoints[i]
        b_lat, b_lng = waypoints[i + 1]
        seg_d = haversine_m(a_lat, a_lng, b_lat, b_lng)
        steps = max(1, int(seg_d / step_m))
        for s in range(1, steps + 1):
            t = s / steps
            coords.append([a_lat + (b_lat - a_lat) * t, a_lng + (b_lng - a_lng) * t])
        total_distance += seg_d
        leg_durations.append(seg_d / walking_speed_mps)
    return {
        "coords": coords,
        "duration": total_distance / walking_speed_mps,
        "distance": total_distance,
        "leg_durations": leg_durations,
        "fallback": True,
    }


class RouteService:
    """Thin async wrapper around the OSRM HTTP API."""

    _REGION_TTL_SECONDS = 600.0  # re-probe a region every 10 minutes
    _PROBE_TIMEOUT = httpx.Timeout(2.5, connect=2.0)
    _TRANSPORT_RETRIES = 1  # extra attempts after a transport failure
    _RETRY_DELAY_S = 0.5

    def __init__(self) -> None:
        # Per-region OSRM coverage cache. Keyed by 1°×1° grid cell (≈110 km
        # square), value is ('ok' | 'down', monotonic_timestamp). 'ok' means
        # OSRM has data here and a normal request worked. 'down' means a probe
        # request to this region timed out / failed (no map coverage or area
        # blocked) so future requests skip OSRM and go straight to fallback.
        # Per-instance to avoid unintentionally sharing state across
        # RouteService instances (api/route.py and SimulationEngine each
        # construct their own).
        self._region_status: dict[tuple[int, int], tuple[str, float]] = {}
        self._region_lock: asyncio.Lock = asyncio.Lock()

    @staticmethod
    def _region_key(lat: float, lng: float) -> tuple[int, int]:
        """Bucket coordinates into a 1°×1° grid cell."""
        import math
        return (int(math.floor(lat)), int(math.floor(lng)))

    async def _region_state(self, key: tuple[int, int]) -> str | None:
        """Return cached status for *key* if still fresh, else None."""
        async with self._region_lock:
            rec = self._region_status.get(key)
            if rec is None:
                return None
            status, checked_at = rec
            if (time.monotonic() - checked_at) >= self._REGION_TTL_SECONDS:
                return None
            return status

    async def _mark_region(self, key: tuple[int, int], status: str) -> None:
        async with self._region_lock:
            self._region_status[key] = (status, time.monotonic())

    # ------------------------------------------------------------------
    # Public helpers
    # ------------------------------------------------------------------

    async def get_route(
        self,
        start_lat: float,
        start_lng: float,
        end_lat: float,
        end_lng: float,
        profile: str = "foot",
        force_straight: bool = False,
    ) -> dict:
        """Plan a route between two points via OSRM.

        When *force_straight* is True, skip OSRM entirely and serve a
        densified straight-line route (used by the global "straight-line"
        toggle for users who want raw bearing-to-point travel).
        """
        waypoints = [
            (start_lat, start_lng),
            (end_lat, end_lng),
        ]
        if force_straight:
            return _straight_line_fallback(waypoints)
        return await self._fetch_route(waypoints, profile)

    async def get_multi_route(
        self,
        waypoints: list[tuple[float, float] | list[float] | dict],
        profile: str = "foot",
        force_straight: bool = False,
    ) -> dict:
        """Plan a route through multiple waypoints.

        *waypoints* may be a list of ``(lat, lng)`` tuples, ``[lat, lng]``
        lists, or dicts with ``lat``/``lng`` keys.
        """
        normalised: list[tuple[float, float]] = []
        for wp in waypoints:
            if isinstance(wp, dict):
                normalised.append((wp["lat"], wp["lng"]))
            else:
                normalised.append((float(wp[0]), float(wp[1])))

        if len(normalised) < 2:
            raise ValueError("At least two waypoints are required")

        if force_straight:
            return _straight_line_fallback(normalised)
        return await self._fetch_route(normalised, profile)

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    async def _fetch_route(
        self,
        waypoints: list[tuple[float, float]],
        profile: str,
    ) -> dict:
        # Strict allowlist: an unknown profile must not be forwarded as a raw
        # path segment to OSRM. Bubble a ValueError so the FastAPI handler
        # surfaces it as a 4xx (the /plan endpoint validates with a Literal
        # type at the boundary, so this is defence-in-depth for direct
        # callers like SimulationEngine).
        osrm_profile = _PROFILE_MAP.get(profile)
        if osrm_profile is None:
            raise ValueError(f"Unknown profile: {profile!r}")

        try:
            return await self._request_route(waypoints, osrm_profile)
        except _OsrmRejected as e:
            if len(waypoints) == 2:
                raise RouteUnavailableError(
                    f"No road route between the two points ({e})"
                ) from e
            # A multi-via request can be refused as a whole while every
            # individual leg is routable — retry leg-by-leg and stitch.
            logger.info(
                "Multi-via OSRM request rejected (%s); retrying leg-by-leg", e,
            )
            return await self._fetch_route_per_leg(waypoints, osrm_profile)

    async def _request_route(
        self,
        waypoints: list[tuple[float, float]],
        osrm_profile: str,
    ) -> dict:
        """Single OSRM request with transport retries.

        Raises :class:`_OsrmRejected` when OSRM refuses the request
        (HTTP 4xx or a non-``Ok`` body) and :class:`RouteUnavailableError`
        when OSRM is unreachable (transport failure / 5xx after retries,
        which also marks the region down, or a region already marked down).
        """
        # Per-region reachability gate: cache OSRM availability by 1°x1°
        # cell keyed off the first waypoint. Only TRANSPORT failures mark a
        # region down (a rejected request says nothing about reachability);
        # while down, fail fast instead of hammering a dead endpoint.
        key = self._region_key(*waypoints[0])
        cached = await self._region_state(key)
        if cached == "down":
            raise RouteServiceUnreachableError(
                "Route planning service unreachable; retrying in a few minutes"
            )
        timeout = _TIMEOUT if cached == "ok" else self._PROBE_TIMEOUT

        # OSRM coordinate pairs are lon,lat (not lat,lon).
        coords_str = ";".join(f"{lng},{lat}" for lat, lng in waypoints)

        # continue_straight=false lets OSRM make a U-turn at intermediate
        # waypoints. The default (continue_straight at vias) makes the demo
        # server return NoRoute for the WHOLE request whenever a route
        # doubles back through a waypoint — common in hand-tapped
        # sightseeing routes.
        url = (
            f"{OSRM_BASE_URL}/route/v1/{osrm_profile}/{coords_str}"
            "?overview=full&geometries=geojson&steps=true"
            "&annotations=duration,distance&continue_straight=false"
        )
        logger.debug("OSRM request: %s", url)

        last_exc: Exception | None = None
        for attempt in range(1 + self._TRANSPORT_RETRIES):
            try:
                client = await _get_client()
                resp = await client.get(url, timeout=timeout)
                if resp.status_code >= 500:
                    # Server-side trouble: same treatment as unreachable.
                    raise httpx.HTTPStatusError(
                        f"HTTP {resp.status_code}", request=resp.request, response=resp,
                    )
            except httpx.HTTPError as e:
                last_exc = e
                if attempt < self._TRANSPORT_RETRIES:
                    await asyncio.sleep(self._RETRY_DELAY_S)
                continue

            # OSRM answers 4xx with the same {code, message} body shape as
            # a 200 NoRoute, so one parse covers both rejection paths.
            try:
                data = resp.json()
            except ValueError:
                data = {}
            if resp.status_code < 400 and data.get("code") == "Ok":
                if cached != "ok":
                    await self._mark_region(key, "ok")
                    logger.info("OSRM region %s confirmed ok", key)
                return self._parse_route(data)
            raise _OsrmRejected(
                data.get("message") or data.get("code") or f"HTTP {resp.status_code}"
            )

        await self._mark_region(key, "down")
        logger.warning(
            "OSRM unreachable for region %s (%s)",
            key, type(last_exc).__name__ if last_exc else "unknown",
        )
        raise RouteServiceUnreachableError(
            "Route planning service unreachable"
        ) from last_exc

    async def _fetch_route_per_leg(
        self,
        waypoints: list[tuple[float, float]],
        osrm_profile: str,
    ) -> dict:
        """Fetch each consecutive waypoint pair separately and stitch.

        Raises :class:`RouteUnavailableError` naming the first leg OSRM
        refuses, so the user knows which segment of the route is broken.
        """
        coords: list[list[float]] = []
        total_duration = 0.0
        total_distance = 0.0
        leg_durations: list[float] = []
        for i in range(len(waypoints) - 1):
            try:
                leg = await self._request_route(
                    [waypoints[i], waypoints[i + 1]], osrm_profile,
                )
            except _OsrmRejected as e:
                raise RouteUnavailableError(
                    f"No road route for leg {i + 1} "
                    f"(waypoint {i + 1} → {i + 2}: {e})"
                ) from e
            # The first point of each subsequent leg duplicates the
            # previous leg's snapped endpoint — drop it when stitching.
            coords.extend(leg["coords"] if not coords else leg["coords"][1:])
            total_duration += leg["duration"]
            total_distance += leg["distance"]
            leg_durations.append(leg["duration"])
        return {
            "coords": coords,
            "duration": total_duration,
            "distance": total_distance,
            "leg_durations": leg_durations,
        }

    @staticmethod
    def _parse_route(data: dict) -> dict:
        route = data["routes"][0]
        geometry = route["geometry"]  # GeoJSON LineString

        # GeoJSON coordinates are [lon, lat]; convert to [lat, lng]
        coords = [
            [pt[1], pt[0]] for pt in geometry["coordinates"]
        ]

        leg_durations = [leg["duration"] for leg in route["legs"]]

        return {
            "coords": coords,
            "duration": route["duration"],
            "distance": route["distance"],
            "leg_durations": leg_durations,
        }
