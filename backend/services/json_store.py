"""Shared machinery for JSON-file-backed Pydantic stores.

``BookmarkManager`` and ``SavedRoutesStore`` follow the same lifecycle:

  load: safe_load_json → migrate raw dict → Pydantic validate →
        quarantine-on-failure → ensure presets → persist-if-changed
  write: ``json.loads(store.model_dump_json())`` → ``safe_write_json``
         (sync during ``__init__`` load, off-thread from async mutators
         under ``self._lock``)

:class:`JsonModelStore` owns that skeleton; subclasses supply the schema,
migration, presets, and logging via small hooks. :func:`reorder_by_ids`
is the shared drag-reorder algorithm used by every ``reorder_*`` mutator.

Quarantine note: ``safe_load_json`` only moves a file aside on JSON
*parse* errors. When the JSON parses but migration / Pydantic validation
fails, the base class renames the file to ``<name>.bak-<UTC ts>`` itself —
otherwise the next mutation would persist a near-empty store over the
user's original bytes.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Generic, Protocol, TypeVar

from pydantic import BaseModel

from services.json_safe import safe_load_json, safe_write_json

logger = logging.getLogger(__name__)

StoreT = TypeVar("StoreT", bound=BaseModel)


class _Orderable(Protocol):
    """Anything with a stable id and a mutable-via-model_copy sort_order."""

    id: str
    sort_order: int

    def model_copy(self, *, update: dict) -> "_Orderable": ...  # noqa: E704


ItemT = TypeVar("ItemT", bound=_Orderable)


class StorePersistError(Exception):
    """A store write to disk failed. The API maps this to 500
    ``store_persist_failed`` so the client never sees a 200 for data that
    only lives in memory."""


def next_sort_order(items: list[ItemT]) -> int:
    """Sort order for a row appended at the end: ``max + 1``, or 0 when
    the list is empty. Shared by every create/insert/import mutator."""
    return max((item.sort_order for item in items), default=-1) + 1


def reorder_by_ids(items: list[ItemT], ordered_ids: list[str]) -> tuple[list[ItemT], int]:
    """Rewrite ``sort_order`` on *items* to match *ordered_ids*.

    Unknown ids are ignored; items not present in *ordered_ids* keep their
    current order. Items are never mutated — changed entries are replaced
    via ``model_copy``. Returns ``(new_items, changed_count)``; when
    ``changed_count`` is 0 the caller can skip swapping/persisting.
    """
    id_to_order = {iid: i for i, iid in enumerate(ordered_ids)}
    changed = 0
    new_items: list[ItemT] = []
    for item in items:
        new_order = id_to_order.get(item.id)
        if new_order is None or item.sort_order == new_order:
            new_items.append(item)
            continue
        new_items.append(item.model_copy(update={"sort_order": new_order}))
        changed += 1
    return new_items, changed


class JsonModelStore(Generic[StoreT]):
    """Base class for a Pydantic store persisted to a single JSON file.

    Subclasses must implement :meth:`_build_default_store` and
    :meth:`_validate`; :meth:`_migrate`, :meth:`_ensure_presets`, and
    :meth:`_log_loaded` are optional hooks. Subclasses own their public
    mutators and must hold ``self._lock`` around every
    mutate-then-``await self._persist()`` cycle.
    """

    # Human-readable label used in load/quarantine log lines.
    store_label: str = "store"

    def __init__(self, file_path: Path) -> None:
        self._file_path = file_path
        # asyncio.Lock created here is bound lazily to the running loop on
        # first acquire (Python 3.10+), so import-time __init__ is safe.
        self._lock = asyncio.Lock()
        # JSON payload matching the file on disk (or the loaded store when
        # the file could not be written). A failed write restores
        # ``self._store`` from it so memory never runs ahead of disk.
        self._persisted_payload: dict | None = None
        self._store: StoreT = self._load()
        if self._persisted_payload is None:
            self._persisted_payload = json.loads(self._store.model_dump_json())

    # ------------------------------------------------------------------
    # Subclass hooks
    # ------------------------------------------------------------------

    def _build_default_store(self) -> StoreT:
        """Fresh store (presets included) used when the file is missing,
        unreadable, or quarantined."""
        raise NotImplementedError

    def _validate(self, raw: dict) -> StoreT:
        """Pydantic-validate the (already migrated) raw dict."""
        raise NotImplementedError

    def _migrate(self, raw: dict) -> tuple[dict, bool]:
        """Reshape an old on-disk dict to the current schema version.

        Returns ``(new_raw, did_migrate)``; ``did_migrate=True`` triggers a
        re-persist after a successful load. Default: no migration.
        """
        return raw, False

    def _ensure_presets(self, store: StoreT) -> tuple[StoreT, bool]:
        """Return *store* with any missing preset rows appended.

        Must be idempotent by id. Returns ``(store, added)``; ``added=True``
        triggers a re-persist after load. Default: nothing to ensure.
        """
        return store, False

    def _log_loaded(self, store: StoreT) -> None:
        """Optional success log after validation. Default: silent."""

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    def _load(self) -> StoreT:
        """Load + migrate + validate the store file, or fall back to defaults.

        Runs synchronously during ``__init__`` (before any event loop), so a
        migration / preset back-fill persists via the blocking writer.
        """
        raw = safe_load_json(self._file_path)
        if raw is None:
            logger.info("No %s file (or unreadable); using defaults", self.store_label)
            return self._build_default_store()
        migrated = False
        try:
            raw, migrated = self._migrate(raw)
            store = self._validate(raw)
        except Exception as exc:
            # JSON parsed but migration / schema validation failed.
            # ``safe_load_json`` only quarantines on JSON parse errors, so we
            # rename the file ourselves — otherwise the next mutation would
            # persist a default store over the user's data.
            self._quarantine_invalid_file(exc)
            return self._build_default_store()
        self._log_loaded(store)
        store, ensured = self._ensure_presets(store)
        if migrated or ensured:
            try:
                self._persist_store(store)
            except StorePersistError:
                # Startup must not fail on a write; the next mutation
                # retries and surfaces the error to the client.
                logger.warning("Could not re-persist %s store after load", self.store_label)
        return store

    def _quarantine_invalid_file(self, exc: Exception) -> None:
        """Rename the on-disk file to ``<name>.bak-<ts>`` so a validation
        failure doesn't get clobbered by the next mutation. Best-effort —
        if the rename itself fails we log and proceed so the app starts."""
        if not self._file_path.exists():
            logger.warning(
                "%s payload failed validation (%s); file missing",
                self.store_label, exc,
            )
            return
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = self._file_path.with_name(f"{self._file_path.name}.bak-{ts}")
        try:
            self._file_path.rename(backup)
            logger.warning(
                "%s payload failed validation (%s); quarantined to %s",
                self.store_label, exc, backup.name,
            )
        except OSError as rename_exc:
            logger.error(
                "%s payload failed validation (%s); rename to %s also failed (%s); "
                "in-memory store will be empty",
                self.store_label, exc, backup.name, rename_exc,
            )

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    def _persist_store(self, store: StoreT) -> None:
        """Serialise + atomically write *store*. Blocking — invoked directly
        during the synchronous ``__init__`` load, or via ``asyncio.to_thread``
        from :meth:`_persist` so the fsync never stalls the event loop.

        Raises :class:`StorePersistError` when the write fails."""
        payload = json.loads(store.model_dump_json())
        if not safe_write_json(self._file_path, payload):
            raise StorePersistError(f"failed to write {self._file_path.name}")
        self._persisted_payload = payload

    async def _persist(self) -> None:
        """Offload the blocking store write to a worker thread.

        Callers hold ``self._lock`` across this await, so no other coroutine
        can mutate the store while the worker thread serialises it — the
        read stays torn-free despite running off the event loop.

        On failure the in-memory store is rolled back to the last written
        payload and :class:`StorePersistError` propagates to the caller.
        """
        try:
            await asyncio.to_thread(self._persist_store, self._store)
        except StorePersistError:
            if self._persisted_payload is not None:
                self._store = self._validate(self._persisted_payload)
            raise
