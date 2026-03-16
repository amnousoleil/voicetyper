"""
Linux text injector — uses xdotool (X11) or ydotool (Wayland) to send Ctrl+V.
Falls back to pynput if neither tool is available.
"""

import logging
import shutil
import subprocess
import os

log = logging.getLogger('voicetyper.injector.linux')


class LinuxInjector:
    """Sends Ctrl+V keystroke on Linux via xdotool, ydotool, or pynput."""

    def __init__(self):
        self._method = self._detect_method()
        log.info(f"Linux injector method: {self._method}")

    def _detect_method(self) -> str:
        # Detect display server
        wayland = os.environ.get('WAYLAND_DISPLAY') or os.environ.get('XDG_SESSION_TYPE') == 'wayland'

        if wayland:
            if shutil.which('ydotool'):
                return 'ydotool'
            elif shutil.which('wtype'):
                return 'wtype'
            else:
                log.warning("Wayland detected but no ydotool/wtype found. Falling back to pynput.")
                return 'pynput'
        else:
            if shutil.which('xdotool'):
                return 'xdotool'
            else:
                log.warning("xdotool not found. Falling back to pynput.")
                return 'pynput'

    def paste(self):
        try:
            if self._method == 'xdotool':
                self._paste_xdotool()
            elif self._method == 'ydotool':
                self._paste_ydotool()
            elif self._method == 'wtype':
                self._paste_wtype()
            else:
                self._paste_pynput()
        except Exception as e:
            log.error(f"LinuxInjector paste error ({self._method}): {e}")
            # Try pynput as final fallback
            if self._method != 'pynput':
                try:
                    self._paste_pynput()
                except Exception as e2:
                    log.error(f"pynput fallback also failed: {e2}")

    def _paste_xdotool(self):
        """X11 — xdotool key ctrl+v"""
        subprocess.run(
            ['xdotool', 'key', '--clearmodifiers', 'ctrl+v'],
            capture_output=True,
            timeout=5,
        )

    def _paste_ydotool(self):
        """Wayland — ydotool key ctrl+v"""
        # ydotool key codes: Ctrl=29, v=47
        subprocess.run(
            ['ydotool', 'key', '29:1', '47:1', '47:0', '29:0'],
            capture_output=True,
            timeout=5,
        )

    def _paste_wtype(self):
        """Wayland — wtype -M ctrl v -m ctrl"""
        subprocess.run(
            ['wtype', '-M', 'ctrl', '-k', 'v', '-m', 'ctrl'],
            capture_output=True,
            timeout=5,
        )

    def _paste_pynput(self):
        """Cross-platform fallback using pynput."""
        from pynput.keyboard import Key, Controller
        kb = Controller()
        with kb.pressed(Key.ctrl):
            kb.press('v')
            kb.release('v')
