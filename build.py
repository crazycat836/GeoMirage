"""
GeoMirage one-shot installer builder (Windows + macOS).

Runs three stages:
  1. PyInstaller bundles the backend into a single folder under
     ``dist-py/geomirage-backend/``.
  2. Vite builds the frontend into ``frontend/dist/``.
  3. electron-builder packages the installer for the current host OS
     into ``frontend/release/``.

Prereqs (install once):
  - Python 3.13 + ``pip install -r backend/requirements.txt pyinstaller``
  - Node.js 18+ + ``cd frontend && npm install``

Usage:
  python build.py                    # full build
  python build.py --skip-backend     # skip stage 1 (reuse existing dist-py)
  python build.py --skip-frontend    # skip stage 2 (reuse existing dist)
  python build.py --skip-installer   # skip stage 3 (dry-run backend/frontend)

The skip flags exist to shorten the debug loop when iterating on one
stage; a fresh build always omits them.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BACKEND = ROOT / "backend"
FRONTEND = ROOT / "frontend"
DIST_PY = ROOT / "dist-py"
BUILD_PY = ROOT / "build-py"
RELEASE = FRONTEND / "release"

# 共用 box-drawing helpers (與 start.py 共用)
sys.path.insert(0, str(ROOT))
from tools.terminal_ui import box_line, box_border  # noqa: E402

BOX_WIDTH = 58


def print_banner(title: str) -> None:
    print()
    print(box_border("╔", "═", "╗", BOX_WIDTH))
    print(box_line(f"   {title}", BOX_WIDTH))
    print(box_border("╚", "═", "╝", BOX_WIDTH))
    print()


def print_step(idx: int, total: int, label: str) -> None:
    print()
    print("  " + "=" * BOX_WIDTH)
    print(f"   [{idx}/{total}] {label}")
    print("  " + "=" * BOX_WIDTH)


def die(msg: str) -> "None":
    print(f"\n  [✗] {msg}", file=sys.stderr)
    sys.exit(1)


# ── Python launcher resolution ───────────────────────────────────────

REQUIRED_PYTHON = (3, 13)


def _python_version(argv: list[str]) -> tuple[int, int] | None:
    """``(major, minor)`` of the interpreter behind *argv*, or None."""
    try:
        out = subprocess.run(
            [*argv, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
            capture_output=True, text=True, timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    try:
        major, minor = out.stdout.strip().split(".")
        return int(major), int(minor)
    except ValueError:
        return None


_resolved_python: list[str] | None = None


def resolve_python() -> list[str]:
    """Return the argv prefix used to invoke Python 3.13 for PyInstaller.

    On Windows tries the ``py -3.13`` launcher (ships with the official
    installer) then ``python`` on PATH. On macOS/Linux tries
    ``python3.13`` then ``python3`` then ``python``. The first candidate
    that actually reports 3.13 wins; if none does, the build aborts and
    lists the versions it found, so a bundle is never built on another
    Python. The caller is responsible for making sure PyInstaller is
    installed in the chosen interpreter.
    """
    global _resolved_python
    if _resolved_python is not None:
        return _resolved_python
    if sys.platform == "win32":
        candidates = [["py", "-3.13"], ["python"]]
    else:
        candidates = [["python3.13"], ["python3"], ["python"]]
    found: list[str] = []
    for cand in candidates:
        path = shutil.which(cand[0])
        if not path:
            continue
        argv = [path, *cand[1:]]
        version = _python_version(argv)
        if version == REQUIRED_PYTHON:
            _resolved_python = argv
            return argv
        label = "%d.%d" % version if version else "unknown"
        found.append(f"{' '.join(cand)} → {label}")
    want = "%d.%d" % REQUIRED_PYTHON
    detail = ";找到:" + "、".join(found) if found else ""
    die(f"找不到 Python {want}{detail}。請安裝 Python {want} 後再打包")
    return []  # unreachable — die() exits


def run(argv: list[str], *, cwd: Path | None = None) -> None:
    """Run a subprocess, abort the build on non-zero exit."""
    print(f"  $ {' '.join(str(a) for a in argv)}")
    result = subprocess.run(argv, cwd=str(cwd) if cwd else None)
    if result.returncode != 0:
        die(f"指令失敗(exit {result.returncode}):{' '.join(str(a) for a in argv)}")


# ── Stages ───────────────────────────────────────────────────────────

def stage_codegen() -> None:
    """Re-run TS-from-Pydantic codegen so frontend/src/generated/api-contract.ts
    matches the live backend WS event registry. Cheap (a few hundred ms);
    run unconditionally so a developer who edited backend/models/ws_events.py
    and forgot to re-run can't ship a stale contract."""
    py = resolve_python()
    run([*py, "tools/gen_ws_types.py"], cwd=ROOT)


def stage_backend() -> None:
    if not (BACKEND / "geomirage-backend.spec").exists():
        die("backend/geomirage-backend.spec 不存在")
    py = resolve_python()
    run(
        [
            *py, "-m", "PyInstaller",
            "geomirage-backend.spec",
            "--noconfirm",
            "--distpath", str(DIST_PY),
            "--workpath", str(BUILD_PY / "backend"),
        ],
        cwd=BACKEND,
    )
    bin_name = "geomirage-backend.exe" if sys.platform == "win32" else "geomirage-backend"
    bin_path = DIST_PY / "geomirage-backend" / bin_name
    if not bin_path.exists():
        die(f"PyInstaller 完成但找不到執行檔:{bin_path}")
    print(f"  [✓] backend → {bin_path}")


def stage_frontend() -> None:
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    if not shutil.which(npm):
        die("找不到 npm,請先從 https://nodejs.org/ 安裝 Node.js 18+")
    run([npm, "run", "build"], cwd=FRONTEND)
    if not (FRONTEND / "dist" / "index.html").exists():
        die(f"Vite 完成但找不到 {FRONTEND / 'dist' / 'index.html'}")
    print(f"  [✓] frontend → {FRONTEND / 'dist'}")


def stage_installer() -> None:
    npm = "npm.cmd" if sys.platform == "win32" else "npm"
    script = "dist:win" if sys.platform == "win32" else "dist:mac"
    run([npm, "run", script], cwd=FRONTEND)
    if not RELEASE.is_dir():
        die(f"electron-builder 完成但找不到 {RELEASE}")
    exts = (".exe",) if sys.platform == "win32" else (".dmg", ".zip")
    outputs = sorted(p for p in RELEASE.iterdir() if p.suffix in exts)
    if not outputs:
        die(f"release/ 資料夾內找不到 {exts} 檔")
    for p in outputs:
        print(f"  [✓] installer → {p}")


# ── Main ─────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="GeoMirage installer builder")
    parser.add_argument("--skip-backend", action="store_true", help="Skip PyInstaller stage")
    parser.add_argument("--skip-frontend", action="store_true", help="Skip Vite stage")
    parser.add_argument("--skip-installer", action="store_true", help="Skip electron-builder stage")
    args = parser.parse_args()

    if sys.platform not in ("win32", "darwin"):
        die(f"目前只支援 Windows 與 macOS,偵測到的平台:{sys.platform}")

    os_label = "Windows" if sys.platform == "win32" else "macOS (arm64)"
    print_banner(f"GeoMirage Build — {os_label}")

    total = 4
    started = time.monotonic()

    print_step(1, total, "Codegen WS event types → frontend/src/generated/api-contract.ts")
    stage_codegen()

    if args.skip_backend:
        print("  [~] 跳過 backend 階段(--skip-backend)")
    else:
        print_step(2, total, f"PyInstaller backend → {DIST_PY.relative_to(ROOT)}/")
        stage_backend()

    if args.skip_frontend:
        print("  [~] 跳過 frontend 階段(--skip-frontend)")
    else:
        print_step(3, total, f"Vite build frontend → {(FRONTEND / 'dist').relative_to(ROOT)}/")
        stage_frontend()

    if args.skip_installer:
        print("  [~] 跳過 installer 階段(--skip-installer)")
    else:
        print_step(4, total, f"electron-builder → {RELEASE.relative_to(ROOT)}/")
        stage_installer()

    elapsed = int(time.monotonic() - started)
    mins, secs = divmod(elapsed, 60)

    print()
    print(box_border("╔", "═", "╗", BOX_WIDTH))
    print(box_line(f"   打包完成(耗時 {mins}m {secs}s)", BOX_WIDTH))
    print(box_line(f"   產物位置:{RELEASE}", BOX_WIDTH))
    print(box_border("╚", "═", "╝", BOX_WIDTH))
    print()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  使用者中斷,結束。")
        sys.exit(130)
