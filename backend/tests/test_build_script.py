"""Tests for the repo-root ``build.py`` packager helpers.

Loaded from its file path under a private name so it can't collide
with the PyPI ``build`` package.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

_spec = importlib.util.spec_from_file_location("geomirage_build", _ROOT / "build.py")
build = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build)


@pytest.fixture
def fake_pythons(monkeypatch):
    """Map PATH candidates to reported versions; unknown names aren't on PATH."""
    versions: dict[str, str] = {}
    monkeypatch.setattr(build, "_resolved_python", None)
    monkeypatch.setattr(build.sys, "platform", "darwin")
    monkeypatch.setattr(
        build.shutil, "which",
        lambda name: f"/usr/bin/{name}" if name in versions else None,
    )

    def fake_run(argv, **kwargs):
        name = Path(argv[0]).name
        return types.SimpleNamespace(returncode=0, stdout=versions[name] + "\n", stderr="")

    monkeypatch.setattr(build.subprocess, "run", fake_run)
    return versions


def test_prefers_a_313_interpreter(fake_pythons):
    fake_pythons.update({"python3": "3.9", "python3.13": "3.13"})
    assert build.resolve_python() == ["/usr/bin/python3.13"]


def test_falls_back_to_python3_when_it_is_313(fake_pythons):
    fake_pythons.update({"python3": "3.13"})
    assert build.resolve_python() == ["/usr/bin/python3"]


def test_aborts_and_reports_versions_without_313(fake_pythons, capsys):
    fake_pythons.update({"python3": "3.9", "python": "3.12"})
    with pytest.raises(SystemExit):
        build.resolve_python()
    err = capsys.readouterr().err
    assert "3.9" in err and "3.12" in err
