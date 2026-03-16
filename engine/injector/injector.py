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
from typing import Optional

log = logging.getLogger('voicetyper.injector')


class TextInjector:
    """
    Detects the current OS and delegates to the platform-specific injector.
    """

    def __init__(self):
        self._impl = self._get_impl()
        log.info(f"TextInjector initialized: {self._impl.__class__.__name__}")

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
            time.sleep(0.05)  # Let clipboard settle
            self._impl.paste()
            time.sleep(0.05)  # Let paste complete
        except Exception as e:
            log.error(f"Injection error: {e}")
        finally:
            # Restore clipboard (slight delay to avoid race with paste)
            time.sleep(0.1)
            if old_clip is not None:
                self._set_clipboard(old_clip)

    def _save_clipboard(self) -> Optional[str]:
        try:
            import pyperclip
            return pyperclip.paste()
        except Exception:
            return None

    def _set_clipboard(self, text: str):
        try:
            import pyperclip
            pyperclip.copy(text)
        except Exception as e:
            log.warning(f"Could not set clipboard: {e}")
