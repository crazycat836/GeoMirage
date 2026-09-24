"""Local-only UI usage log.

The renderer batches interaction events (clicks, dialog open/close, API
calls) and posts them to ``POST /api/usage/events``; this module appends
them to a monthly JSONL file under ``DATA_DIR/usage/``. Nothing leaves
the machine, and events never carry request bodies or coordinates — the
renderer only sends labels, region names and API paths.

``tools/usage_report.py`` reads these files to answer UX questions
(which features get used, how many clicks each action takes, which
dialogs get abandoned).
"""

from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable

from services.json_safe import open_private_append

logger = logging.getLogger(__name__)


class UsageLog:
    """Append-only JSONL writer, one file per calendar month."""

    def __init__(self, directory: Path) -> None:
        self._dir = directory
        self._lock = threading.Lock()

    def path_for(self, when: datetime) -> Path:
        return self._dir / f"usage-{when:%Y-%m}.jsonl"

    def append(self, events: Iterable[dict[str, Any]], now: datetime | None = None) -> int:
        """Write *events* as JSON lines. Returns how many were written.

        Failures are logged and swallowed: usage logging must never break
        the action the user was performing.
        """
        lines = [json.dumps(e, ensure_ascii=False, separators=(",", ":")) for e in events]
        if not lines:
            return 0
        target = self.path_for(now or datetime.now())
        try:
            with self._lock:
                self._dir.mkdir(parents=True, exist_ok=True)
                # 0600, sudo-invoker-owned, and never through a symlink.
                with open_private_append(target) as fh:
                    fh.write("\n".join(lines) + "\n")
        except OSError:
            logger.warning("Failed to append usage events to %s", target, exc_info=True)
            return 0
        return len(lines)
