#!/usr/bin/env bash
# VoiceTyper — Build script
# Compiles Python sidecar with PyInstaller, then builds Electron app
# Usage: bash scripts/build.sh [win|mac|linux|all]

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

log()   { echo -e "${BLUE}[build]${NC} $*"; }
ok()    { echo -e "${GREEN}[ok]${NC} $*"; }
warn()  { echo -e "${YELLOW}[!]${NC} $*"; }
error() { echo -e "${RED}[x]${NC} $*"; exit 1; }

PLATFORM="${1:-current}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

# ─── Find Python ──────────────────────────────────────────────────────────────
PYTHON=""
for cmd in python3 python python3.12 python3.11 python3.10; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done
[ -z "$PYTHON" ] && error "Python 3.8+ not found"

# ─── Step 1: Compile Python sidecar ───────────────────────────────────────────
echo -e "\n${BOLD}Step 1: Compiling Python engine with PyInstaller...${NC}"

if ! $PYTHON -c "import PyInstaller" 2>/dev/null; then
    log "Installing PyInstaller..."
    $PYTHON -m pip install pyinstaller>=6.0 -q
fi

mkdir -p bin

log "Running PyInstaller..."
cd engine
$PYTHON -m PyInstaller \
    --onefile \
    --name dictee_engine \
    --noconfirm \
    --clean \
    --paths . \
    --hidden-import vosk \
    --hidden-import sounddevice \
    --hidden-import _sounddevice_data \
    --hidden-import numpy \
    --hidden-import _cffi_backend \
    --hidden-import aiohttp \
    --hidden-import aiohttp.web \
    --hidden-import aiohttp.web_app \
    --hidden-import multidict \
    --hidden-import yarl \
    --hidden-import aiosignal \
    --hidden-import frozenlist \
    --hidden-import async_timeout \
    --hidden-import attrs \
    --hidden-import pyperclip \
    --hidden-import segno \
    --hidden-import pynput \
    --hidden-import pynput.keyboard \
    --exclude-module torch \
    --exclude-module faster_whisper \
    --exclude-module tensorflow \
    --exclude-module tkinter \
    dictee_engine.py

cd "$ROOT_DIR"

# Copy the right binary
if [[ -f engine/dist/dictee_engine.exe ]]; then
    cp engine/dist/dictee_engine.exe bin/dictee_engine.exe
    ok "Python engine compiled to bin/dictee_engine.exe"
elif [[ -f engine/dist/dictee_engine ]]; then
    cp engine/dist/dictee_engine bin/dictee_engine
    chmod +x bin/dictee_engine
    ok "Python engine compiled to bin/dictee_engine"
else
    error "PyInstaller output not found in engine/dist/"
fi

# ─── Step 2: Build Electron app ───────────────────────────────────────────────
echo -e "\n${BOLD}Step 2: Building Electron app...${NC}"

if [ ! -d node_modules ]; then
    log "Installing npm dependencies first..."
    npm install
fi

case "$PLATFORM" in
    win|windows)    npm run build:win ;;
    mac|macos)      npm run build:mac ;;
    linux)          npm run build:linux ;;
    all)            npm run build:all ;;
    current|*)
        if [[ "$OSTYPE" == "win32"* || "$OSTYPE" == "msys"* || "$OSTYPE" == "cygwin"* ]]; then
            npm run build:win
        elif [[ "$OSTYPE" == "darwin"* ]]; then
            npm run build:mac
        else
            npm run build:linux
        fi
        ;;
esac

echo ""
echo -e "${GREEN}${BOLD}Build complete!${NC}"
echo -e "  Output: ${BOLD}release/${NC}"
ls release/ 2>/dev/null || true
echo ""
