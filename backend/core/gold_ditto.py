"""Gold Ditto (拉金盆) handler.

Pikmin Bloom game-assist action. The in-game gold flower bud needs a
"swipe down" gesture to harvest its reward, which the game detects by
watching for a fast GPS coordinate change. We approximate that by
pushing the device's simulated location to the user's real-position
anchor (``A``) and then immediately restoring real GPS.

Flow:

  1. Stop any active simulation so the cycle isn't immediately
     overwritten by the next movement-loop tick.
  2. Push location_service.set() directly (NOT engine.teleport): the
     teleport handler emits ``position_update`` which would auto-recenter
     the desktop map on A. The user wants to keep watching the
     manually-flown gold-flower view, so we route around the WS emit.
  3. Hand off to engine.restore() — the iPhone goes back on real GPS,
     completing the "swipe" the game looks for.

There's deliberately no internal delay; the user picks the timing
visually (after the flower bud animation prompt), and pressing the
button is the trigger.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from core.simulation_engine import SimulationEngine

logger = logging.getLogger(__name__)


class GoldDittoHandler:
    """One-shot cycle helper that swaps simulated→real GPS at the
    user-supplied anchor coordinate."""

    def __init__(self, engine: "SimulationEngine") -> None:
        self.engine = engine

    async def cycle(self, lat: float, lng: float) -> None:
        """Run a single Gold Ditto cycle anchored at ``(lat, lng)``.

        ``lat``/``lng`` is the user's real-world position — pushing the
        simulated location there and then restoring real GPS is what
        the game sees as a "swipe", because the apparent jump from the
        gold-flower spot back to real GPS goes through this anchor.
        """
        if self.engine.is_busy():
            await self.engine.stop()

        await self.engine.location_service.set(lat, lng)
        await self.engine._emit("gold_ditto_cycle", {
            "phase": "teleported",
            "lat": lat,
            "lng": lng,
        })

        await self.engine.restore()
        await self.engine._emit("gold_ditto_cycle", {"phase": "restored"})

        logger.info("Gold Ditto cycle done at (%.6f, %.6f)", lat, lng)
