"""
GeoMirage 一鍵啟動器
雙擊此檔案即可啟動 GeoMirage
"""

import json
import subprocess
import sys
import os
import time
import shutil
import webbrowser
import socket

# 路徑設定
ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")

# 共用 box-drawing helpers (與 build.py 共用) + port 清理 helper (與 stop.py 共用)
sys.path.insert(0, ROOT)
from tools.terminal_ui import (  # noqa: E402
    box_line,
    box_border,
    bold,
    dim,
    green,
    cyan,
)
from tools.ports import kill_port  # noqa: E402

# Single source of truth for the backend bind port lives in backend/config.py;
# importing it here keeps start / stop / backend in lockstep automatically.
sys.path.insert(0, BACKEND)
from config import API_PORT as BACKEND_PORT  # noqa: E402

FRONTEND_PORT = 5173  # Vite dev-server default; not a backend concern


def _app_version() -> str:
    """Read the canonical version from frontend/package.json."""
    try:
        with open(os.path.join(FRONTEND, "package.json"), encoding="utf-8") as f:
            return json.load(f).get("version", "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


APP_VERSION = _app_version()


def adopt_legacy_env() -> None:
    """Accept the pre-rename ``GPSCONTROLLER_*`` variables.

    An existing ``.env.dev`` or shell export may still use the old prefix;
    copy those onto the ``GEOMIRAGE_*`` names unless the new name is set.
    The backend inherits this environment.
    """
    for suffix in ("DEV_NOAUTH", "OPEN_BROWSER"):
        legacy = os.environ.get(f"GPSCONTROLLER_{suffix}")
        if legacy is not None:
            os.environ.setdefault(f"GEOMIRAGE_{suffix}", legacy)


def load_dotenv_dev() -> str | None:
    """Load `.env.dev` from the repo root into os.environ.

    Real env vars already exported by the user take precedence (dotenv
    convention) so a one-off `GEOMIRAGE_DEV_NOAUTH=0 python start.py`
    can still flip auth back on without editing the file. Returns the
    path that was loaded for the launcher banner, or None when no file
    is present. Kept tiny so we don't drag in python-dotenv just for
    a five-key dev override.
    """
    path = os.path.join(ROOT, ".env.dev")
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return None
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export "):].lstrip()
        if "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()
        # Strip surrounding quotes if both ends match — leave inner
        # quotes alone (a value of {"a":1} should survive untouched).
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1]
        if not key or key in os.environ:
            continue
        os.environ[key] = value
    return path


procs = []

BOX_WIDTH = 46


def print_banner():
    print()
    print(box_border("╔", "═", "╗", BOX_WIDTH))
    print(box_line("   " + bold("GeoMirage") + dim("  ·  iOS 虛擬定位模擬器"), BOX_WIDTH))
    print(box_line("   " + dim(f"一鍵啟動器  v{APP_VERSION}"), BOX_WIDTH))
    print(box_border("╚", "═", "╝", BOX_WIDTH))
    print()


def _tool_version(name: str) -> str:
    """Best-effort `<tool> --version`, normalised to a short string.

    Returns "" when the tool can't report a version so the caller can
    still render the found/not-found line without a dangling label.
    """
    try:
        out = subprocess.run(
            [name, "--version"],
            capture_output=True, text=True, timeout=5,
            shell=(os.name == "nt"),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    raw = (out.stdout or out.stderr).strip().splitlines()
    if not raw:
        return ""
    # `python --version` prints "Python 3.12.1"; node/npm print "v26.3.0" /
    # "11.16.0". Keep just the version token, prefixing "v" when bare.
    token = raw[0].replace("Python", "").strip()
    return token if token.startswith("v") or not token[:1].isdigit() else f"v{token}"


def check_tool(name, hint):
    if shutil.which(name):
        version = _tool_version(name)
        suffix = "  " + dim(version) if version else ""
        print(f"  [{green('✓')}] 已找到 {bold(name)}{suffix}")
        return True
    else:
        print(f"  [✗] 找不到 {name}，請先安裝：{hint}")
        return False


def is_port_open(port):
    """檢查 port 是否有服務在監聽"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except (ConnectionRefusedError, OSError, TimeoutError):
        return False


def wait_for_port(port, label, timeout=60, proc=None):
    print(f"      等待{label}啟動中", end="", flush=True)
    start = time.time()
    while time.time() - start < timeout:
        # The port may be held by another instance (e.g. a root backend
        # this user can't see or kill), so an open port alone doesn't
        # prove *our* process started.
        if proc is not None and proc.poll() is not None:
            print(f" 失敗！行程已結束（exit code {proc.returncode}）")
            return False
        if is_port_open(port):
            print(" OK ✓")
            return True
        print(".", end="", flush=True)
        time.sleep(2)
    print(" 超時！")
    return False


def _is_effective_root() -> bool:
    """POSIX effective-root check (sudo). Windows has no geteuid — False."""
    return os.name != "nt" and os.geteuid() == 0


def _refuse_root_install(what: str) -> None:
    """Explain why dependency installation is blocked under sudo.

    Running `pip install` / `npm install` as root would execute arbitrary
    package install scripts with full root privileges and litter
    root-owned files into the user's caches. Installation must happen
    once unprivileged; sudo is only needed afterwards for the iOS 17+
    tunnel.
    """
    print("尚未安裝 ✗")
    print(f"      [!] 偵測到以 sudo / root 執行，拒絕以 root 權限安裝{what}。")
    print("      請先以一般使用者執行一次 python3 start.py 完成依賴安裝，")
    print("      再視需要（iOS 17+ 通道）改用 sudo python3 start.py 啟動。")


def _report_failure(what: str, result: subprocess.CompletedProcess) -> None:
    """Print a failed install step with its exit code and captured stderr.

    Steps run without ``capture_output`` already streamed their errors to
    the terminal, so ``result.stderr`` is None and only the code is shown.
    """
    print("失敗 ✗")
    print(f"      [!] {what} 失敗（exit code {result.returncode}）")
    for line in (result.stderr or "").strip().splitlines():
        print(f"      {line}")


def install_backend() -> bool:
    """Ensure backend deps are installed. Returns False when blocked or failed."""
    print("  [1/4] 檢查後端依賴...", end=" ", flush=True)
    req = os.path.join(BACKEND, "requirements.txt")

    dry = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", req, "--dry-run", "-q"],
        capture_output=True, text=True,
    )
    if dry.returncode != 0:
        _report_failure("pip install --dry-run", dry)
        return False

    if "would install" not in dry.stdout.lower():
        print("已就緒 ✓")
        return True
    if _is_effective_root():
        # Never run package install scripts as root — see _refuse_root_install.
        _refuse_root_install("後端依賴 (pip install)")
        return False
    print("安裝中...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", req, "-q"],
        cwd=BACKEND,
    )
    if result.returncode != 0:
        _report_failure("pip install", result)
        return False
    print("        完成 ✓")
    return True


# Written into node_modules after a successful `npm install`. Its mtime
# (or that of npm's own hidden lockfile) must not be older than
# package-lock.json; a newer lock means a pull or dependency bump since
# the last install.
_INSTALL_STAMP = ".geomirage-install-stamp"
# Filesystem / checkout mtime jitter; npm writes both lockfiles within
# the same install, so a small gap isn't a real change.
_LOCK_MTIME_SLACK_S = 2.0


def _frontend_deps_stale() -> bool:
    """True when node_modules is missing or older than package-lock.json."""
    nm = os.path.join(FRONTEND, "node_modules")
    if not os.path.isdir(nm):
        return True
    try:
        lock_mtime = os.path.getmtime(os.path.join(FRONTEND, "package-lock.json"))
    except OSError:
        return False  # no lockfile to compare against
    installed = 0.0
    for marker in (".package-lock.json", _INSTALL_STAMP):
        try:
            installed = max(installed, os.path.getmtime(os.path.join(nm, marker)))
        except OSError:
            pass
    return lock_mtime > installed + _LOCK_MTIME_SLACK_S


def _mark_frontend_installed() -> None:
    try:
        with open(os.path.join(FRONTEND, "node_modules", _INSTALL_STAMP), "w"):
            pass
    except OSError:
        pass


def install_frontend() -> bool:
    """Ensure frontend deps are installed. Returns False when blocked or failed."""
    print("  [2/4] 檢查前端依賴...", end=" ", flush=True)
    if not _frontend_deps_stale():
        print("已就緒 ✓")
        return True
    if _is_effective_root():
        # Never run npm lifecycle scripts as root — see _refuse_root_install.
        _refuse_root_install("前端依賴 (npm install)")
        return False
    print("安裝中...")
    result = subprocess.run(["npm", "install"], cwd=FRONTEND, shell=(os.name == "nt"))
    if result.returncode != 0:
        _report_failure("npm install", result)
        return False
    _mark_frontend_installed()
    print("        完成 ✓")
    return True


def start_backend():
    print(f"  [3/4] 啟動後端服務 (port {BACKEND_PORT})...")

    # 清理殘留
    if is_port_open(BACKEND_PORT):
        print(f"      Port {BACKEND_PORT} 被佔用，清理中...")
        kill_port(BACKEND_PORT)
        time.sleep(1)
        if is_port_open(BACKEND_PORT):
            # Held by a process we can't see or kill (e.g. a backend the
            # packaged app started as root). Starting another would only
            # fail to bind, so stop here instead of reporting success.
            print(
                f"      Port {BACKEND_PORT} 仍被其他行程佔用（可能是以管理員權限"
                "執行的 GeoMirage），請先關閉它再重試。"
            )
            return False

    # Dev mode: leave the session token check on by default. The launcher
    # used to silently set GEOMIRAGE_DEV_NOAUTH=1 here so `vite dev`
    # on port 5173 (no Electron preload to inject the token) could reach
    # the backend; that is a footgun in shared/dev environments. Make the
    # opt-in explicit: surface a one-line hint when the flag is unset and
    # a warning when it's already exported.
    env = dict(os.environ)
    if env.get("GEOMIRAGE_DEV_NOAUTH") == "1":
        print(
            "      [!] GEOMIRAGE_DEV_NOAUTH=1 detected — backend auth DISABLED. "
            "Unset it to require X-GPS-Token."
        )
    else:
        print(
            "      [i] Backend auth ENABLED. To run the Vite dev server without "
            "the Electron preload, export GEOMIRAGE_DEV_NOAUTH=1 yourself."
        )

    p = subprocess.Popen(
        [sys.executable, "main.py"],
        cwd=BACKEND,
        env=env,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    procs.append(p)
    return wait_for_port(BACKEND_PORT, "後端", proc=p)


def _drop_to_sudo_user(env: dict) -> dict:
    """Popen kwargs that run a child as the user who invoked ``sudo``.

    Only the backend needs root (iOS 17+ tunnel). Vite running as root
    leaves a root-owned ``node_modules/.vite`` cache that breaks every
    later unprivileged ``vite`` / ``vite build`` with EACCES. When this
    process is effective root and ``SUDO_UID`` / ``SUDO_GID`` are set,
    return ``user`` / ``group`` / ``extra_groups`` for Popen and point
    ``HOME`` / ``USER`` / ``LOGNAME`` in *env* at that user. Otherwise
    return ``{}`` and leave *env* untouched.
    """
    if not _is_effective_root():
        return {}
    try:
        uid = int(env["SUDO_UID"])
        gid = int(env["SUDO_GID"])
    except (KeyError, ValueError):
        return {}
    if uid == 0:
        return {}
    import pwd  # POSIX-only; _is_effective_root() is False on Windows

    try:
        pw = pwd.getpwuid(uid)
    except KeyError:
        return {}
    env["HOME"] = pw.pw_dir
    env["USER"] = pw.pw_name
    env["LOGNAME"] = pw.pw_name
    try:
        groups = os.getgrouplist(pw.pw_name, gid)
    except OSError:
        groups = [gid]
    return {"user": uid, "group": gid, "extra_groups": groups}


def _remove_root_owned_vite_cache() -> None:
    """Delete a ``node_modules/.vite`` cache left behind by a root Vite.

    Earlier launcher versions ran Vite as root under sudo; the demoted
    Vite can't write into that cache. It is only a cache, so drop it.
    """
    cache = os.path.join(FRONTEND, "node_modules", ".vite")
    try:
        if os.stat(cache).st_uid == 0:
            shutil.rmtree(cache, ignore_errors=True)
    except OSError:
        pass


def start_frontend():
    print(f"  [4/4] 啟動前端服務 (port {FRONTEND_PORT})...")

    # 清理殘留
    if is_port_open(FRONTEND_PORT):
        print(f"      Port {FRONTEND_PORT} 被佔用，清理中...")
        kill_port(FRONTEND_PORT)
        time.sleep(1)

    # Vite 8 still calls the deprecated `module.register()` for its
    # TS-config loader, so Node 21+ prints a one-line DEP0205 warning on
    # every dev-server start. Silence just that one code (not all warnings,
    # and without patching node_modules) until Vite moves to
    # `module.registerHooks()`. Append so any user-set NODE_OPTIONS survive.
    env = dict(os.environ)
    disable_flag = "--disable-warning=DEP0205"
    node_opts = env.get("NODE_OPTIONS", "")
    if disable_flag not in node_opts:
        env["NODE_OPTIONS"] = f"{node_opts} {disable_flag}".strip()

    # Under `sudo python3 start.py` only the backend keeps root; Vite runs
    # as the invoking user so its cache in node_modules/.vite stays theirs.
    demote = _drop_to_sudo_user(env)
    if demote:
        _remove_root_owned_vite_cache()

    # 用 --port 強制指定 port，避免 Vite 跳到其他 port
    # Bind the Vite dev server to loopback only. Without an explicit value
    # `--host` defaults to 0.0.0.0 and exposes the unauthenticated dev UI
    # to anything on the LAN; pin to 127.0.0.1 so this is a local tool.
    p = subprocess.Popen(
        ["npx", "vite", "--host", "127.0.0.1", "--port", str(FRONTEND_PORT), "--strictPort"],
        cwd=FRONTEND,
        env=env,
        shell=(os.name == "nt"),
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
        **demote,
    )
    procs.append(p)
    return wait_for_port(FRONTEND_PORT, "前端", proc=p)


def cleanup():
    print("\n  正在關閉所有服務...")
    for p in procs:
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    # 強制清理殘留 port
    kill_port(BACKEND_PORT)
    kill_port(FRONTEND_PORT)
    print("  已停止。再見！")


def _should_open_browser() -> bool:
    """是否在啟動後自動開瀏覽器。

    預設關閉，避免每次啟動都跳出新分頁。要開啟時擇一：
      • 執行時加上 `--open` 或 `-o`
      • 設環境變數 `GEOMIRAGE_OPEN_BROWSER=1`
    """
    if "--open" in sys.argv or "-o" in sys.argv:
        return True
    return os.environ.get("GEOMIRAGE_OPEN_BROWSER", "") == "1"


def check_admin():
    """Check if running with administrator/root privileges."""
    if os.name == "nt":
        import ctypes
        try:
            return ctypes.windll.shell32.IsUserAnAdmin()
        except Exception:
            return False
    else:
        return os.geteuid() == 0


def main():
    if os.name == "nt":
        os.system("title GeoMirage")
    print_banner()

    loaded_env = load_dotenv_dev()
    adopt_legacy_env()
    if loaded_env:
        print(f"  [i] Loaded {os.path.relpath(loaded_env, ROOT)} (exported env still wins)")
        print()

    # 檢查管理員權限 (iOS 17+ 需要)
    if not check_admin():
        print("  [!] 未以系統管理員身份執行")
        print("      iOS 17+ 裝置需要管理員權限才能建立通道")
        if os.name == "nt":
            print("      請以系統管理員身份開啟 CMD / PowerShell 後執行 python start.py")
        else:
            print("      請使用 sudo python3 start.py 執行")
        print()

    # 檢查環境
    ok = True
    py_name = "python" if shutil.which("python") else "python3"
    ok = check_tool(py_name, "https://www.python.org/downloads/") and ok
    ok = check_tool("node", "https://nodejs.org/") and ok
    ok = check_tool("npm", "隨 Node.js 一起安裝") and ok
    print()

    if not ok:
        input("  缺少必要工具，請安裝後重試。按 Enter 離開...")
        return

    # 安裝依賴（以 root 執行且尚未安裝時會被拒絕 — 見 _refuse_root_install）
    deps_ok = install_backend()
    print()
    deps_ok = install_frontend() and deps_ok
    print()
    if not deps_ok:
        input("  依賴尚未就緒，請依上方訊息處理後重試。按 Enter 離開...")
        return

    # 啟動服務
    if not start_backend():
        print("  [錯誤] 後端啟動失敗，請查看上方錯誤訊息")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    if not start_frontend():
        print("  [錯誤] 前端啟動失敗")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    # 等待 Vite 完成首次編譯
    time.sleep(2)
    url = f"http://localhost:{FRONTEND_PORT}"

    # 預設不自動開瀏覽器。要自動開啟時：加上 --open / -o 旗標，
    # 或設環境變數 GEOMIRAGE_OPEN_BROWSER=1。
    if _should_open_browser():
        webbrowser.open(url)

    # Tint the side bars green too so the whole frame reads as one green box;
    # content keeps its own colour (each ║ wrap resets before the content).
    def ready_line(content: str) -> str:
        return box_line(content, BOX_WIDTH).replace("║", green("║"))

    print(green(box_border("╔", "═", "╗", BOX_WIDTH)))
    print(ready_line("          " + green(bold("GeoMirage 已就緒！"))))
    print(green(box_border("╠", "═", "╣", BOX_WIDTH)))
    print(ready_line(f"  前端畫面:  {cyan(f'http://localhost:{FRONTEND_PORT}')}"))
    print(ready_line(f"  後端 API:  {cyan(f'http://localhost:{BACKEND_PORT}')}"))
    print(ready_line(f"  API 文件:  {cyan(f'http://localhost:{BACKEND_PORT}/docs')}"))
    print(green(box_border("╠", "═", "╣", BOX_WIDTH)))
    print(ready_line("  " + dim("按 Enter 停止所有服務")))
    print(green(box_border("╚", "═", "╝", BOX_WIDTH)))
    print()

    try:
        input()
    except (KeyboardInterrupt, EOFError):
        pass

    cleanup()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        cleanup()
