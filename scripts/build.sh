#!/usr/bin/env bash
# VoiceTyper — Build script
# Compiles Python sidecar with PyInstaller, then builds Electron app
# Usage: bash scripts/build.sh [--platform win|mac|linux|all]

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()   { echo -e "${BLUE}[build]${NC} $*"; }
ok()    { echo -e "${GREEN}[✓]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[✗]${NC} $*"; exit 1; }

# ─── Args ─────────────────────────────────────────────────────────────────────
PLATFORM="${1:-current}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ─── Find Python ──────────────────────────────────────────────────────────────
PYTHON=""
for cmd in python3 python3.12 python3.11 python3.10 python3.9 python3.8; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done
[ -z "$PYTHON" ] && error "Python 3.8+ not found"

# ─── Step 1: Compile Python sidecar ───────────────────────────────────────────
echo -e "\n${BOLD}Step 1: Compiling Python engine with PyInstaller…${NC}"

if ! $PYTHON -c "import PyInstaller" 2>/dev/null; then
    log "Installing PyInstaller…"
    $PYTHON -m pip install pyinstaller>=6.0 -q
fi

log "Running PyInstaller…"
$PYTHON -m PyInstaller \
    --onedir \
    --name dictee_engine \
    --distpath dist \
    --workpath build/pyinstaller_work \
    --specpath build \
    --noconfirm \
    --clean \
    --hidden-import vosk \
    --hidden-import sounddevice \
    --hidden-import numpy \
    --hidden-import aiohttp \
    --hidden-import aiohttp_cors \
    --hidden-import pyperclip \
    --hidden-import segno \
    --collect-all vosk \
    --collect-all sounddevice \
    engine/dictee_engine.py

ok "Python engine compiled to dist/dictee_engine/"

# ─── Step 2: Copy UI files into dist ─────────────────────────────────────────
echo -e "\n${BOLD}Step 2: Bundling UI files…${NC}"
mkdir -p dist/dictee_engine/ui
cp -r ui/* dist/dictee_engine/ui/
ok "UI files copied to dist/dictee_engine/ui/"

# ─── Step 3: Build Electron app ───────────────────────────────────────────────
echo -e "\n${BOLD}Step 3: Building Electron app…${NC}"

if [ ! -d node_modules ]; then
    log "Installing npm dependencies first…"
    npm install
fi

case "$PLATFORM" in
    win|windows)
        log "Building for Windows…"
        npm run build:win
        ;;
    mac|macos|darwin)
        log "Building for macOS…"
        npm run build:mac
        ;;
    linux)
        log "Building for Linux…"
        npm run build:linux
        ;;
    all)
        log "Building for all platforms…"
        npm run build:all
        ;;
    current|*)
        log "Building for current platform…"
        if [[ "$OSTYPE" == "win32"* || "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
            npm run build:win
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            npm run build:mac
        else
            npm run build:linux
        fi
        ;;
esac

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Build complete!${NC}"
echo -e "${GREEN}${BOLD}════════════════════════════════════════════${NC}"
echo ""
echo -e "  Output: ${BOLD}release/${NC}"
ls release/ 2>/dev/null || true
echo ""
