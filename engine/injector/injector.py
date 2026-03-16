"""
Universal text injector — types text into the currently active window.

Strategy: clipboard + paste keystroke (Ctrl+V / Cmd+V).
This works reliably across all apps (browser, Word, Slack, terminals, etc.)
without needing accessibility permissions on most systems.

The original clipboard content is saved and restored after injection.
"""

import logging
import platform
import time
import sys
from typing import Optional

log = logging.getLogger('voicetyper.injector')


class TextInjector:
    """
    Detects the current OS and delegates to the platform-specific injector.
    """

    def __init__(self):
        self._impl = self._get_impl()
        self._clipboard_backend = self._detect_clipboard_backend()
        log.info(f"TextInjector initialized: {self._impl.__class__.__name__}, clipboard={self._clipboard_backend}")

    def _get_impl(self):
        os_name = platform.system()
        if os_name == 'Windows':
            from .win_injector import WinInjector
            return WinInjector()
        elif os_name == 'Darwin':
            from .mac_injector import MacInjector
            return MacInjector()
        else:
            from .linux_injector import LinuxInjector
            return LinuxInjector()

    def _detect_clipboard_backend(self) -> str:
        """Detect which clipboard mechanism works."""
        # On Windows, prefer win32clipboard for reliability (avoids pyperclip issues)
        if platform.system() == 'Windows':
            try:
                import win32clipboard
                return 'win32'
            except ImportError:
                pass
        try:
            import pyperclip
            return 'pyperclip'
        except ImportError:
            log.warning("No clipboard library available (install pyperclip)")
            return 'none'

    def inject(self, text: str):
        """
        Inject text into the currently focused window.
        Adds a trailing space for natural dictation flow.
        Blocks until injection is complete.
        """
        if not text or not text.strip():
            return

        text_to_inject = text.strip() + ' '

        # Save clipboard
        old_clip = self._save_clipboard()

        try:
            self._set_clipboard(text_to_inject)
            # FIX: longer delay on Windows for clipboard propagation
            delay = 0.08 if platform.system() == 'Windows' else 0.05
            time.sleep(delay)
            self._impl.paste()
            time.sleep(delay)
        except Exception as e:
            log.error(f"Injection error: {e}")
        finally:
            # FIX: longer delay before restoring clipboard to avoid paste race
            time.sleep(0.2 if platform.system() == 'Windows' else 0.15)
            if old_clip is not None:
                try:
                    self._set_clipboard(old_clip)
                except Exception as e:
                    log.debug(f"Could not restore clipboard: {e}")

    def _save_clipboard(self) -> Optional[str]:
        try:
            if self._clipboard_backend == 'win32':
                return self._win32_get_clipboard()
            elif self._clipboard_backend == 'pyperclip':
                import pyperclip
                return pyperclip.paste()
        except Exception as e:
            log.debug(f"Could not save clipboard: {e}")
        return None

    def _set_clipboard(self, text: str):
        try:
            if self._clipboard_backend == 'win32':
                self._win32_set_clipboard(text)
            elif self._clipboard_backend == 'pyperclip':
                import pyperclip
                pyperclip.copy(text)
            else:
                log.warning("No clipboard backend — text injection may fail")
        except Exception as e:
            log.warning(f"Could not set clipboard: {e}")

    # ── Windows native clipboard (win32clipboard) ─────────────────────────────
    def _win32_get_clipboard(self) -> Optional[str]:
        """Read clipboard using win32clipboard (more reliable on Windows)."""
        import win32clipboard
        import win32con
        try:
            win32clipboard.OpenClipboard()
            try:
                if win32clipboard.IsClipboardFormatAvailable(win32con.CF_UNICODETEXT):
                    data = win32clipboard.GetClipboardData(win32con.CF_UNICODETEXT)
                    return data
            finally:
                win32clipboard.CloseClipboard()
        except Exception as e:
            log.debug(f"win32clipboard get error: {e}")
        return None

    def _win32_set_clipboard(self, text: str):
        """Write to clipboard using win32clipboard."""
        import win32clipboard
        import win32con
        try:
            win32clipboard.OpenClipboard()
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32con.CF_UNICODETEXT, text)
            finally:
                win32clipboard.CloseClipboard()
        except Exception as e:
            log.warning(f"win32clipboard set error: {e}")
