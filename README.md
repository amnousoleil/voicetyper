# VoiceTyper

Universal voice-to-text dictation — type with your voice in any application.

## Features

- **Global hotkey** `Ctrl+Alt+Space` — start/stop dictation from any app
- **100% offline** — Vosk engine, no internet required after first model download
- **Universal injection** — works in browsers, Word, Slack, terminals, etc.
- **Phone bridge** — scan QR code, dictate from your phone's microphone
- **10 languages** — French, English, Spanish, German, Italian, Portuguese, Russian, Arabic, Chinese, Japanese
- **Two STT engines** — Vosk (fast, offline) or Whisper (precise, optional GPU)

## Quick Start

```bash
bash scripts/setup.sh
npm start
```

## Usage

1. Launch VoiceTyper — it appears in the system tray
2. Click the **DICTER** button or press `Ctrl+Alt+Space`
3. Speak — text is injected into the active window
4. Press the button again or the hotkey to stop

### Phone dictation

1. Open VoiceTyper and find the QR code section
2. Scan with your phone (same Wi-Fi network required)
3. Tap **DICTER** on the phone — your voice is transcribed and injected on the desktop

## Installation

### Prerequisites

- **Node.js** 18+ — https://nodejs.org
- **Python** 3.8+ — https://www.python.org
- **Linux**: `sudo apt-get install xdotool` (for text injection)
- **macOS**: Accessibility permission required (System Preferences → Security & Privacy → Accessibility)

### Setup

```bash
git clone <repo>
cd voicetyper
bash scripts/setup.sh
```

On first dictation, the app automatically downloads the Vosk model for the selected language (~40MB for small models).

## Build

```bash
bash scripts/build.sh           # Current platform
bash scripts/build.sh linux     # Linux AppImage + deb
bash scripts/build.sh win       # Windows NSIS installer
bash scripts/build.sh mac       # macOS DMG
bash scripts/build.sh all       # All platforms
```

Output: `release/`

## Architecture

```
Electron (main.js)
  ├── BrowserWindow (ui/index.html)  — main UI
  ├── Tray icon + context menu
  ├── Global shortcut (Ctrl+Alt+Space)
  └── WebSocket client → Python engine (port 7523)

Python engine (engine/dictee_engine.py)
  ├── aiohttp server on :7523
  │   ├── /ws        — Electron UI WebSocket
  │   ├── /ws/phone  — Mobile phone WebSocket
  │   ├── /phone     — Mobile HTML page
  │   └── /status    — JSON health check
  ├── STT engines
  │   ├── vosk_engine.py   — offline, Vosk
  │   └── whisper_engine.py — faster-whisper
  └── Text injectors
      ├── win_injector.py   — Windows SendInput
      ├── mac_injector.py   — macOS AppleScript
      └── linux_injector.py — xdotool / ydotool / pynput
```

## Troubleshooting

### Text not injected (Linux)
```bash
sudo apt-get install xdotool    # X11
sudo apt-get install ydotool    # Wayland
```

### Text not injected (macOS)
Go to **System Preferences → Security & Privacy → Privacy → Accessibility** and add VoiceTyper.

### Microphone not detected
```bash
python3 -c "import sounddevice; print(sounddevice.query_devices())"
```

### Engine not starting
```bash
python3 engine/dictee_engine.py --debug
```

### Model download slow
Models are downloaded to `~/.voicetyper/models/`. You can manually download from https://alphacephei.com/vosk/models and extract there.

## License

MIT
