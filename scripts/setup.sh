#!/usr/bin/env bash
# VoiceTyper — Setup script
# Usage: bash scripts/setup.sh

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()    { echo -e "${BLUE}[setup]${NC} $*"; }
ok()     { echo -e "${GREEN}[✓]${NC} $*"; }
warn()   { echo -e "${YELLOW}[!]${NC} $*"; }
error()  { echo -e "${RED}[✗]${NC} $*"; }
header() { echo -e "\n${BOLD}$*${NC}"; }

# ─── Root dir ─────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"
log "Working in: $ROOT_DIR"

# ─── Check Python ─────────────────────────────────────────────────────────────
header "1. Checking Python…"

PYTHON=""
for cmd in python3 python3.12 python3.11 python3.10 python3.9 python3.8; do
    if command -v "$cmd" &>/dev/null; then
        version=$("$cmd" --version 2>&1 | grep -oP '\d+\.\d+' | head -1)
        major=$(echo "$version" | cut -d. -f1)
        minor=$(echo "$version" | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 8 ]; then
            PYTHON="$cmd"
            ok "Found $cmd ($version)"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    error "Python 3.8+ not found."
    echo "Install Python 3.10+ from https://www.python.org/downloads/"
    exit 1
fi

# ─── Install Python dependencies ──────────────────────────────────────────────
header "2. Installing Python dependencies…"

if ! $PYTHON -m pip install --upgrade pip -q 2>&1; then
    warn "Could not upgrade pip (continuing)"
fi

log "Installing from engine/requirements.txt…"
if $PYTHON -m pip install -r engine/requirements.txt; then
    ok "Python dependencies installed"
else
    error "pip install failed"
    echo "Try: $PYTHON -m pip install -r engine/requirements.txt --user"
    exit 1
fi

# ─── Linux: check xdotool ─────────────────────────────────────────────────────
if [[ "$OSTYPE" == "linux-gnu"* ]]; then
    header "2b. Linux: checking xdotool…"
    if command -v xdotool &>/dev/null; then
        ok "xdotool found"
    else
        warn "xdotool not found — text injection may not work"
        echo "Install it with:"
        echo "  Ubuntu/Debian: sudo apt-get install xdotool"
        echo "  Fedora: sudo dnf install xdotool"
        echo "  Arch: sudo pacman -S xdotool"
        echo ""
        echo "For Wayland: sudo apt-get install ydotool"
    fi
fi

# ─── macOS: check accessibility ───────────────────────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
    header "2b. macOS: accessibility note"
    warn "VoiceTyper needs Accessibility permission to inject text."
    echo "After first launch, go to:"
    echo "  System Preferences → Security & Privacy → Privacy → Accessibility"
    echo "  and add VoiceTyper to the allowed apps list."
fi

# ─── Check Node.js ────────────────────────────────────────────────────────────
header "3. Checking Node.js…"

if ! command -v node &>/dev/null; then
    error "Node.js not found."
    echo "Install Node.js 18+ from https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version | grep -oP '\d+' | head -1)
if [ "$NODE_VERSION" -lt 18 ]; then
    error "Node.js 18+ required (found v$NODE_VERSION)"
    exit 1
fi

ok "Node.js $(node --version)"

if ! command -v npm &>/dev/null; then
    error "npm not found"
    exit 1
fi
ok "npm $(npm --version)"

# ─── Install Node.js dependencies ─────────────────────────────────────────────
header "4. Installing Node.js dependencies…"

if npm install; then
    ok "Node dependencies installed"
else
    error "npm install failed"
    exit 1
fi

# ─── Create config directory ──────────────────────────────────────────────────
header "5. Creating config directory…"
mkdir -p "$HOME/.voicetyper/models"
ok "Created ~/.voicetyper/models"

# ─── Verify engine syntax ─────────────────────────────────────────────────────
header "6. Verifying Python syntax…"

ERRORS=0
for f in engine/dictee_engine.py \
          engine/stt/vosk_engine.py \
          engine/stt/whisper_engine.py \
          engine/injector/injector.py \
          engine/injector/linux_injector.py \
          engine/injector/mac_injector.py \
          engine/injector/win_injector.py \
          engine/server/http_server.py \
          engine/server/ws_handler.py; do
    if $PYTHON -m py_compile "$f" 2>/dev/null; then
        ok "$f"
    else
        error "$f — syntax error!"
        $PYTHON -m py_compile "$f"
        ERRORS=$((ERRORS + 1))
    fi
done

if [ "$ERRORS" -gt 0 ]; then
    error "$ERRORS file(s) have syntax errors"
    exit 1
fi

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  VoiceTyper setup complete!${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════${NC}"
echo ""
echo -e "  Start the app:   ${BOLD}npm start${NC}"
echo -e "  Test engine:     ${BOLD}$PYTHON engine/dictee_engine.py --debug${NC}"
echo -e "  Build release:   ${BOLD}bash scripts/build.sh${NC}"
echo ""
echo -e "  Shortcut:  ${BOLD}Ctrl+Alt+Space${NC} from any app"
echo ""
