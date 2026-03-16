"""
macOS text injector — uses AppleScript to send Cmd+V.
Requires accessibility permissions for the app.
"""

import logging
import subprocess

log = logging.getLogger('voicetyper.injector.mac')

APPLESCRIPT_CMD_V = '''
tell application "System Events"
    keystroke "v" using {command down}
end tell
'''


class MacInjector:
    """Sends Cmd+V via AppleScript."""

    def paste(self):
        try:
            result = subprocess.run(
                ['osascript', '-e', APPLESCRIPT_CMD_V],
                capture_output=True,
                timeout=5,
            )
            if result.returncode != 0:
                err = result.stderr.decode().strip()
                if 'not allowed' in err.lower():
                    log.error(
                        "macOS accessibility permission denied. "
                        "Go to System Preferences → Security & Privacy → Accessibility "
                        "and add VoiceTyper."
                    )
                else:
                    log.warning(f"AppleScript error: {err}")
        except subprocess.TimeoutExpired:
            log.error("AppleScript timed out")
        except FileNotFoundError:
            log.error("osascript not found — not running on macOS?")
        except Exception as e:
            log.error(f"MacInjector paste error: {e}")
