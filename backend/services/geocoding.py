"""Nominatim forward / reverse geocoding service."""

from __future__ import annotations

import logging

import httpx

from config import NOMINATIM_BASE_URL, NOMINATIM_USER_AGENT
from models.schemas import GeocodingResult
from services import geocoding_google, geocoding_photon
from services.http_client import (
    GEOCODING_HTTP_TIMEOUT,
    make_async_client_singleton,
    make_min_interval_gate,
)

logger = logging.getLogger(__name__)

# Lifespan-scoped HTTP client. Reusing the connection pool across calls
# avoids paying TCP+TLS handshake on every search / reverse during a
# 10 Hz navigation. Closed on FastAPI shutdown via close_client().
# The Nominatim usage policy requires a UA + JSON Accept header on every
# request, so they're attached as defaults on the client itself — per-call
# headers (Accept-Language for reverse) merge on top.
_get_client, close_client = make_async_client_singleton(
    GEOCODING_HTTP_TIMEOUT,
    headers={
        "User-Agent": NOMINATIM_USER_AGENT,
        "Accept": "application/json",
    },
)


# Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
# requires no more than 1 request per second. A frontend bug or local
# attacker could otherwise hammer this proxy and trigger an IP ban that
# affects every user behind the NAT. Serialize all outbound calls
# through a single-slot gate with a ≥1s spacing (factory lives in
# http_client so Nominatim + Photon share one implementation).
_NOMINATIM_MIN_INTERVAL_S = 1.05  # tiny safety margin

# Single-slot spacing gate shared by search + reverse.
_nominatim_rate_limit = make_min_interval_gate(_NOMINATIM_MIN_INTERVAL_S)


class GeocodingService:
    """Async wrapper around the Nominatim geocoding API."""

    # ------------------------------------------------------------------
    # Forward geocoding
    # ------------------------------------------------------------------

    async def search(
        self,
        query: str,
        limit: int = 5,
        lang: str | None = None,
        google_key: str | None = None,
        provider: str | None = None,
    ) -> list[GeocodingResult]:
        """Forward geocode: address or place name -> coordinates.

        Provider dispatch (``provider`` selects the backend explicitly):

        - ``"google"`` -> Google Places Text Search (best POI / business /
          fuzzy-name quality; the user's own key + billing). Falls back to
          Photon when no usable ``google_key`` was supplied so the box still
          returns results instead of silently failing.
        - ``"nominatim"`` -> Nominatim forward search (same OSM dataset used
          for reverse geocoding; strict 1 req/s).
        - ``"photon"`` -> Photon (keyless, OSM-backed, typeahead-friendly).

        When ``provider`` is ``None`` (older clients), the legacy heuristic
        applies: Google if a key is present, else Photon.

        Reverse geocoding always stays on Nominatim (see :meth:`reverse`).

        Parameters
        ----------
        query:
            Free-form search string (e.g. ``"Taipei 101"``).
        limit:
            Maximum number of results.
        lang:
            UI language chain (e.g. ``"zh-Hant,zh-TW,zh,en"``) used to
            localize result names where the provider supports it.
        google_key:
            User-supplied Google Places API key forwarded by the renderer.
        provider:
            ``"nominatim" | "photon" | "google"`` or ``None`` for the legacy
            key-presence heuristic.

        Returns
        -------
        list[GeocodingResult]

        Network / upstream failures are logged by each provider and surfaced
        as an empty list, so the caller never receives a 500 for transient
        issues or a misconfigured key.
        """
        selected = (provider or ("google" if google_key else "photon")).lower()
        if selected == "google":
            if google_key:
                return await geocoding_google.search(query, google_key, limit=limit, lang=lang)
            # Google chosen but no usable key — degrade to Photon so the
            # search box keeps working while the user adds their key.
            return await geocoding_photon.search(query, limit=limit, lang=lang)
        if selected == "nominatim":
            return await self._nominatim_search(query, limit=limit, lang=lang)
        return await geocoding_photon.search(query, limit=limit, lang=lang)

    async def _nominatim_search(
        self, query: str, limit: int = 5, lang: str | None = None
    ) -> list[GeocodingResult]:
        """Forward geocode via Nominatim ``/search``. Returns ``[]`` on any
        upstream failure so the caller keeps the "empty == unavailable"
        contract. Shares the module's 1 req/s rate-limit gate + client."""
        params: dict[str, object] = {
            "q": query,
            "format": "json",
            "addressdetails": 1,
            "limit": min(limit, 40),
        }
        # UA + Accept are client defaults; only Accept-Language is per-call.
        headers = {"Accept-Language": lang} if lang else None

        logger.debug("Nominatim search: %s", query)

        try:
            await _nominatim_rate_limit()
            client = await _get_client()
            resp = await client.get(
                f"{NOMINATIM_BASE_URL}/search",
                params=params,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            logger.warning("Nominatim search unreachable (%s): %s", type(exc).__name__, exc)
            return []
        except httpx.HTTPStatusError as exc:
            logger.warning("Nominatim search HTTP %d: %s", exc.response.status_code, exc.response.text[:200])
            return []
        except httpx.HTTPError as exc:
            logger.warning("Nominatim search failed (%s): %s", type(exc).__name__, exc)
            return []

        if not isinstance(data, list):
            return []

        results: list[GeocodingResult] = []
        for item in data:
            if not isinstance(item, dict):
                continue
            try:
                addr = item.get("address") or {}
                results.append(
                    GeocodingResult(
                        display_name=item.get("display_name", ""),
                        lat=float(item["lat"]),
                        lng=float(item["lon"]),
                        type=item.get("type", ""),
                        importance=float(item.get("importance", 0)),
                        country_code=(addr.get("country_code") or "").lower(),
                        country=addr.get("country") or "",
                        place_name=_pick_place_name(item, addr),
                    )
                )
            except (KeyError, ValueError) as exc:
                logger.warning("Skipping malformed Nominatim search result: %s", exc)

        return results

    # ------------------------------------------------------------------
    # Reverse geocoding
    # ------------------------------------------------------------------

    async def reverse(
        self, lat: float, lng: float, lang: str | None = None, *, strict: bool = False
    ) -> GeocodingResult | None:
        """Reverse geocode: coordinates -> address.

        Passing ``lang`` forwards an ``accept-language`` hint to Nominatim so
        ``address.country`` is returned in the requested language.

        Returns ``None`` when no result is found. With ``strict``, network
        and HTTP failures are re-raised instead of also returning ``None``,
        so a caller can tell "no answer" from "no country here".
        """
        params: dict[str, object] = {
            "lat": lat,
            "lon": lng,
            "format": "json",
            "addressdetails": 1,
        }
        # UA + Accept are client defaults; only Accept-Language is per-call.
        headers = {"Accept-Language": lang} if lang else None

        logger.debug("Nominatim reverse: %.6f, %.6f", lat, lng)

        # Network / upstream failures are logged and surfaced as None so the
        # frontend's reverse-geocode hook falls back to "no flag / no country"
        # instead of throwing away the whole status pair on a transient DNS
        # or timeout hiccup.
        try:
            await _nominatim_rate_limit()
            client = await _get_client()
            resp = await client.get(
                f"{NOMINATIM_BASE_URL}/reverse",
                params=params,
                headers=headers,
            )
            resp.raise_for_status()
            data = resp.json()
        except (httpx.ConnectError, httpx.TimeoutException) as exc:
            logger.warning("Nominatim reverse unreachable (%s): %s", type(exc).__name__, exc)
            if strict:
                raise
            return None
        except httpx.HTTPStatusError as exc:
            logger.warning("Nominatim reverse HTTP %d: %s", exc.response.status_code, exc.response.text[:200])
            if strict:
                raise
            return None
        except httpx.HTTPError as exc:
            logger.warning("Nominatim reverse failed (%s): %s", type(exc).__name__, exc)
            if strict:
                raise
            return None

        if "error" in data:
            logger.info("Nominatim reverse returned error: %s", data["error"])
            return None

        try:
            addr = data.get("address") or {}
            return GeocodingResult(
                display_name=data.get("display_name", ""),
                lat=float(data["lat"]),
                lng=float(data["lon"]),
                type=data.get("type", ""),
                importance=float(data.get("importance", 0)),
                country_code=(addr.get("country_code") or "").lower(),
                country=addr.get("country") or "",
                place_name=_pick_place_name(data, addr),
            )
        except (KeyError, ValueError) as exc:
            logger.warning("Failed to parse reverse result: %s", exc)
            return None


# POI > road > administrative order for label extraction. Picking the first
# non-empty field keeps bookmark names meaningful ("Taipei 101", "Xinyi Rd")
# instead of degenerate house numbers like "6號".
_PLACE_PRIORITY: tuple[str, ...] = (
    "amenity",
    "tourism",
    "shop",
    "historic",
    "leisure",
    "building",
    "attraction",
    "office",
    "neighbourhood",
    "suburb",
    "road",
    "pedestrian",
    "city_district",
    "city",
    "town",
    "village",
    "county",
    "state_district",
    "state",
)


def _pick_place_name(data: dict, addr: dict) -> str:
    """Extract the most specific non-trivial place label from a Nominatim
    reverse payload. Returns an empty string if no usable label exists."""
    # Nominatim's top-level `name` field (when present) is the canonical label
    # for POIs — prefer it over anything in the address tree.
    top_name = data.get("name")
    if isinstance(top_name, str) and top_name.strip():
        return top_name.strip()
    for key in _PLACE_PRIORITY:
        v = addr.get(key)
        if isinstance(v, str) and v.strip():
            return v.strip()
    # Last-resort fallback: a bare house number is more useful than nothing
    # but less useful than any hierarchy tier — included for completeness.
    hn = addr.get("house_number")
    if isinstance(hn, str) and hn.strip():
        road = addr.get("road")
        if isinstance(road, str) and road.strip():
            return f"{road.strip()} {hn.strip()}"
        return hn.strip()
    return ""
