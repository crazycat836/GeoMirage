"""Joystick handler -- realtime directional control."""

from __future__ import annotations

import asyncio
import logging

from models.schemas import JoystickInput, MovementMode, SimulationState
from services.interpolator import RouteInterpolator
from config import SPEED_PROFILES

logger = logging.getLogger(__name__)

# How often the joystick loop ticks (seconds). 80 ms ≈ 12.5 Hz nominal,
# ~8-10 Hz effective after each tick's device-write + WS emit overhead.
# Lower than this risks queueing the location-set call on slow WiFi
# tunnels; higher values feel visibly choppy for a real-time input.
_TICK_INTERVAL = 0.08


class JoystickHandler:
    """Provides realtime joystick-style movement control.

    The user sends direction (0-360 degrees) and intensity (0-1) inputs.
    A background loop runs at the ``_TICK_INTERVAL`` cadence, calculating
    a new position based on the current input and speed profile, then
    pushing the update to the device.
    """

    def __init__(self, engine):
        self.engine = engine
        self.is_active: bool = False
        self.speed_profile: dict | None = None
        self._task: asyncio.Task | None = None
        self._current_input = JoystickInput(direction=0, intensity=0)

    async def start(self, mode: MovementMode) -> None:
        """Activate joystick mode with the given movement speed profile."""
        engine = self.engine

        if engine.current_position is None:
            raise RuntimeError(
                "Cannot start joystick: no current position. Teleport first."
            )

        # Stop any running simulation first
        if engine.is_busy():
            await engine.stop()

        profile_name = mode.value
        self.speed_profile = SPEED_PROFILES[profile_name]
        self.is_active = True
        self._current_input = JoystickInput(direction=0, intensity=0)

        engine.state = SimulationState.JOYSTICK
        engine._stop_event.clear()

        await engine._emit("state_change", {"state": engine.state.value})

        self._task = asyncio.create_task(self._loop())
        logger.info("Joystick started [%s]", profile_name)

    def update_input(self, joystick_input: JoystickInput) -> None:
        """Update the current joystick direction and intensity.

        Called from WebSocket messages -- must be non-blocking.
        """
        self._current_input = joystick_input

    async def _loop(self) -> None:
        """Main joystick tick loop.

        Runs every ``_TICK_INTERVAL`` seconds. Reads the current input,
        computes a new position, and pushes it to the device.
        """
        engine = self.engine

        try:
            while self.is_active and not engine._stop_event.is_set():
                inp = self._current_input

                if inp.intensity > 0 and engine.current_position is not None:
                    speed_mps = self.speed_profile["speed_mps"] * inp.intensity * inp.sensitivity
                    distance = speed_mps * _TICK_INTERVAL  # meters this tick
                    jitter = self.speed_profile.get("jitter", 0.3)

                    # Calculate new position
                    new_lat, new_lng = RouteInterpolator.move_point(
                        engine.current_position.lat,
                        engine.current_position.lng,
                        inp.direction,
                        distance,
                    )

                    # Add GPS jitter
                    new_lat, new_lng = RouteInterpolator.add_jitter(
                        new_lat, new_lng, jitter * 0.3,
                    )

                    # Push to device
                    await engine._set_position(new_lat, new_lng)

                    # Accumulate distance
                    engine.distance_traveled += distance

                    await engine._emit("position_update", {
                        "lat": new_lat,
                        "lng": new_lng,
                        "speed_mps": speed_mps,
                        "bearing": inp.direction,
                    })

                # Check pause
                if not engine._pause_event.is_set():
                    await engine._pause_event.wait()

                await asyncio.sleep(_TICK_INTERVAL)
        except asyncio.CancelledError:
            pass
        except Exception:
            logger.exception("Joystick loop error")
        finally:
            self.is_active = False

    async def stop(self) -> None:
        """Deactivate joystick mode."""
        self.is_active = False

        if self._task is not None and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

        self._current_input = JoystickInput(direction=0, intensity=0)
        logger.info("Joystick stopped")
