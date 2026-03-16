"""
WebSocket message handler helpers.
Provides message schema definitions and validation for the VoiceTyper protocol.
"""

from typing import TypedDict, Literal, Optional, Any
import json
import logging

log = logging.getLogger('voicetyper.ws')


# ─── Message types (from Electron UI → Engine) ────────────────────────────────

class StartDictationMsg(TypedDict):
    type: Literal['start_dictation']


class StopDictationMsg(TypedDict):
    type: Literal['stop_dictation']


class SetLanguageMsg(TypedDict):
    type: Literal['set_language']
    lang: str  # 'fr', 'en', 'es', etc.


class SetEngineMsg(TypedDict):
    type: Literal['set_engine']
    engine: Literal['vosk', 'whisper']


# ─── Message types (from Phone → Engine) ─────────────────────────────────────

class PhoneTranscriptMsg(TypedDict):
    type: Literal['transcript']
    text: str
    lang: str
    is_final: bool


# ─── Message types (from Engine → UI) ────────────────────────────────────────

class TranscriptMsg(TypedDict):
    type: Literal['transcript']
    text: str
    is_final: bool
    source: Literal['mic', 'phone']


class StatusMsg(TypedDict):
    type: Literal['status']
    state: Literal['idle', 'listening', 'processing']


class QRCodeMsg(TypedDict):
    type: Literal['qr_code']
    url: str
    svg: str


class ErrorMsg(TypedDict):
    type: Literal['error']
    message: str
    code: Optional[str]


class ModelDownloadMsg(TypedDict):
    type: Literal['model_download']
    model: str
    progress: float    # 0-100
    status: Literal['downloading', 'extracting', 'done', 'error']
    size: str          # human-readable, e.g. '41MB'


# ─── Helpers ──────────────────────────────────────────────────────────────────

def parse_message(raw: str) -> Optional[dict]:
    """Parse a raw WebSocket message string to dict. Returns None on error."""
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError) as e:
        log.warning(f"Failed to parse WS message: {e} — raw: {raw[:80]}")
        return None


def serialize(msg: dict) -> str:
    """Serialize a message dict to JSON string."""
    return json.dumps(msg, ensure_ascii=False)


def make_status(state: str) -> str:
    return serialize({'type': 'status', 'state': state})


def make_transcript(text: str, is_final: bool, source: str = 'mic') -> str:
    return serialize({'type': 'transcript', 'text': text, 'is_final': is_final, 'source': source})


def make_error(message: str, code: Optional[str] = None) -> str:
    return serialize({'type': 'error', 'message': message, 'code': code})


def make_qr(url: str, svg: str) -> str:
    return serialize({'type': 'qr_code', 'url': url, 'svg': svg})


def make_model_download(model: str, progress: float, status: str, size: str = '') -> str:
    return serialize({
        'type': 'model_download',
        'model': model,
        'progress': progress,
        'status': status,
        'size': size,
    })
