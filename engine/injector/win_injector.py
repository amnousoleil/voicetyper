"""
Windows text injector — uses SendInput (ctypes) with Ctrl+V.
Primary method: ctypes SendInput (no external dependency).
Fallback: pywin32 keybd_event (if ctypes fails).
"""

import logging
import time
import ctypes
from ctypes import wintypes

log = logging.getLogger('voicetyper.injector.win')

# ─── Constants ────────────────────────────────────────────────────────────────
VK_CONTROL = 0x11
VK_V = 0x56
INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_EXTENDEDKEY = 0x0001


# ─── SendInput structures ────────────────────────────────────────────────────
class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ('wVk', wintypes.WORD),
        ('wScan', wintypes.WORD),
        ('dwFlags', wintypes.DWORD),
        ('time', wintypes.DWORD),
        ('dwExtraInfo', ctypes.POINTER(ctypes.c_ulong)),
    ]


class INPUT_UNION(ctypes.Union):
    _fields_ = [
        ('ki', KEYBDINPUT),
        # Mouse and hardware input omitted — not needed
    ]


class INPUT(ctypes.Structure):
    _fields_ = [
        ('type', wintypes.DWORD),
        ('union', INPUT_UNION),
    ]


# FIX: keep a persistent pointer to avoid GC issues
_EXTRA_INFO = ctypes.c_ulong(0)
_EXTRA_INFO_PTR = ctypes.pointer(_EXTRA_INFO)


def _make_key_input(vk, flags=0):
    """Create an INPUT structure for a keyboard event."""
    inp = INPUT()
    inp.type = INPUT_KEYBOARD
    inp.union.ki.wVk = vk
    inp.union.ki.wScan = 0
    inp.union.ki.dwFlags = flags
    inp.union.ki.time = 0
    inp.union.ki.dwExtraInfo = _EXTRA_INFO_PTR
    return inp


class WinInjector:
    """Sends Ctrl+V keystroke via Windows SendInput API."""

    def paste(self):
        try:
            self._paste_sendinput()
        except Exception as e:
            log.warning(f"SendInput failed ({e}), trying pywin32 fallback")
            try:
                self._paste_pywin32()
            except ImportError:
                log.error("pywin32 not available either — paste failed completely")
            except Exception as e2:
                log.error(f"pywin32 fallback also failed: {e2}")

    def _paste_sendinput(self):
        """Primary method: ctypes SendInput (no external deps needed)."""
        inputs = (INPUT * 4)(
            _make_key_input(VK_CONTROL),           # Ctrl down
            _make_key_input(VK_V),                  # V down
            _make_key_input(VK_V, KEYEVENTF_KEYUP), # V up
            _make_key_input(VK_CONTROL, KEYEVENTF_KEYUP),  # Ctrl up
        )

        # Small delay to ensure the clipboard content is ready
        time.sleep(0.03)

        result = ctypes.windll.user32.SendInput(
            4,
            ctypes.byref(inputs),
            ctypes.sizeof(INPUT),
        )

        if result != 4:
            error_code = ctypes.GetLastError()
            raise RuntimeError(f"SendInput returned {result}, expected 4 (error={error_code})")

    def _paste_pywin32(self):
        """Fallback using pywin32."""
        import win32api
        import win32con

        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        time.sleep(0.02)
        win32api.keybd_event(ord('V'), 0, 0, 0)
        time.sleep(0.02)
        win32api.keybd_event(ord('V'), 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.02)
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)
