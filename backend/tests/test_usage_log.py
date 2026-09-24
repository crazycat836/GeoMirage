"""Tests for the local usage log (services/usage_log.py + api/usage.py)."""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path

import pytest
from pydantic import ValidationError

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from api.usage import UsageBatch  # noqa: E402
from services.usage_log import UsageLog  # noqa: E402


def test_append_writes_monthly_jsonl(tmp_path: Path) -> None:
    log = UsageLog(tmp_path / "usage")
    when = datetime(2026, 9, 14, 12, 0)

    assert log.append([{"type": "click", "label": "瞬移"}], now=when) == 1
    assert log.append([{"type": "api", "path": "/api/location/teleport"}], now=when) == 1

    lines = (tmp_path / "usage" / "usage-2026-09.jsonl").read_text("utf-8").splitlines()
    assert [json.loads(l)["type"] for l in lines] == ["click", "api"]
    assert json.loads(lines[0])["label"] == "瞬移"


def test_append_empty_is_noop(tmp_path: Path) -> None:
    log = UsageLog(tmp_path / "usage")
    assert log.append([]) == 0
    assert not (tmp_path / "usage").exists()


def test_append_swallows_write_errors(tmp_path: Path) -> None:
    blocker = tmp_path / "usage"
    blocker.write_text("not a directory")
    assert UsageLog(blocker).append([{"type": "click"}]) == 0


def test_batch_drops_unknown_fields_and_rejects_bad_type() -> None:
    batch = UsageBatch.model_validate(
        {"events": [{"ts": 1, "session": "s", "type": "api", "lat": 25.0}]}
    )
    # Unknown keys (e.g. coordinates) are not carried into the dump.
    assert "lat" not in batch.events[0].model_dump(exclude_none=True)

    with pytest.raises(ValidationError):
        UsageBatch.model_validate({"events": [{"ts": 1, "session": "s", "type": "scroll"}]})


def test_events_endpoint_appends(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    import api.usage as usage_api

    monkeypatch.setattr(usage_api, "_usage_log", UsageLog(tmp_path))
    app = FastAPI()
    app.include_router(usage_api.router)

    res = TestClient(app).post("/api/usage/events", json={"events": [
        {"ts": 1, "session": "s", "type": "click", "region": "bottom.dock", "label": "Start"},
    ]})

    assert res.status_code == 200
    assert res.json() == {"written": 1}
    (written,) = tmp_path.glob("usage-*.jsonl")
    assert json.loads(written.read_text("utf-8"))["label"] == "Start"


def test_append_refuses_symlinked_file(tmp_path: Path) -> None:
    victim = tmp_path / "victim"
    victim.write_text("keep", encoding="utf-8")
    usage_dir = tmp_path / "usage"
    usage_dir.mkdir()
    when = datetime(2026, 9, 14, 12, 0)
    (usage_dir / "usage-2026-09.jsonl").symlink_to(victim)

    assert UsageLog(usage_dir).append([{"type": "click"}], now=when) == 0
    assert victim.read_text(encoding="utf-8") == "keep"


def test_append_file_is_private(tmp_path: Path) -> None:
    log = UsageLog(tmp_path / "usage")
    when = datetime(2026, 9, 14, 12, 0)
    log.append([{"type": "click"}], now=when)
    assert (log.path_for(when).stat().st_mode & 0o777) == 0o600
