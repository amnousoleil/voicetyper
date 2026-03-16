"""
Windows text injector — uses SendInput with Ctrl+V.
"""

import logging
import time

log = logging.getLogger('voicetyper.injector.win')


class WinInjector:
    """Sends Ctrl+V keystroke via Windows API."""

    def paste(self):
        try:
            self._paste_win32()
        except ImportError:
            log.warning("pywin32 not available, falling back to ctypes")
            self._paste_ctypes()
        except Exception as e:
            log.error(f"WinInjector paste error: {e}")

    def _paste_win32(self):
        """Use pywin32 (most reliable)."""
        import win32api
        import win32con

        # Press Ctrl
        win32api.keybd_event(win32con.VK_CONTROL, 0, 0, 0)
        time.sleep(0.02)
        # Press V
        win32api.keybd_event(ord('V'), 0, 0, 0)
        time.sleep(0.02)
        # Release V
        win32api.keybd_event(ord('V'), 0, win32con.KEYEVENTF_KEYUP, 0)
        time.sleep(0.02)
        # Release Ctrl
        win32api.keybd_event(win32con.VK_CONTROL, 0, win32con.KEYEVENTF_KEYUP, 0)

    def _paste_ctypes(self):
        """Fallback using ctypes SendInput."""
        import ctypes
        from ctypes import wintypes

        # Virtual key codes
        VK_CONTROL = 0x11
        VK_V = 0x56
        KEYEVENTF_KEYUP = 0x0002

        class KEYBDINPUT(ctypes.Structure):
            _fields_ = [
                ('wVk', wintypes.WORD),
                ('wScan', wintypes.WORD),
                ('dwFlags', wintypes.DWORD),
                ('time', wintypes.DWORD),
                ('dwExtraInfo', ctypes.POINTER(wintypes.ULONG)),
            ]

        class INPUT_union(ctypes.Union):
            _fields_ = [('ki', KEYBDINPUT)]

        class INPUT(ctypes.Structure):
            _fields_ = [('type', wintypes.DWORD), ('union', INPUT_union)]

        INPUT_KEYBOARD = 1

        def make_key(vk, flags=0):
            inp = INPUT()
            inp.type = INPUT_KEYBOARD
            inp.union.ki.wVk = vk
            inp.union.ki.wScan = 0
            inp.union.ki.dwFlags = flags
            inp.union.ki.time = 0
            inp.union.ki.dwExtraInfo = ctypes.pointer(wintypes.ULONG(0))
            return inp

        inputs = [
            make_key(VK_CONTROL),
            make_key(VK_V),
            make_key(VK_V, KEYEVENTF_KEYUP),
            make_key(VK_CONTROL, KEYEVENTF_KEYUP),
        ]

        InputArray = INPUT * len(inputs)
        arr = InputArray(*inputs)
        ctypes.windll.user32.SendInput(len(inputs), arr, ctypes.sizeof(INPUT))
