#!/usr/bin/env python3
"""
VoiceTyper Engine — Main orchestrator
Runs as a sidecar process spawned by Electron.
Communicates via WebSocket on port 7523.

WebSocket routes:
  /ws        → UI (Electron renderer)
  /ws/phone  → Mobile phone clients

HTTP routes:
  GET /         → redirect to /phone
  GET /phone    → phone.html
  GET /status   → JSON status
"""

import asyncio
import json
import logging
import signal
import sys
import platform
import socket
import os
import argparse
from pathlib import Path

try:
    from aiohttp import web
    import aiohttp
except ImportError:
    print("[FATAL] aiohttp not installed. Run: pip install aiohttp aiohttp-cors", file=sys.stderr)
    sys.exit(1)

try:
    import segno
except ImportError:
    segno = None

# ─── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] [%(levelname)s] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('voicetyper')

# ─── Config ───────────────────────────────────────────────────────────────────
CONFIG_DIR = Path.home() / '.voicetyper'
CONFIG_FILE = CONFIG_DIR / 'config.json'
MODELS_DIR = CONFIG_DIR / 'models'

DEFAULT_CONFIG = {
    'lang': 'fr',
    'engine': 'vosk',
    'model_size': 'small',
    'port': 7523,
}


# ─── Engine class ─────────────────────────────────────────────────────────────
class VoiceTyperEngine:
    def __init__(self, port: int = 7523):
        self.port = port
        self.config = self._load_config()
        self.config['port'] = port

        # Connection sets
        self.ui_clients: set[web.WebSocketResponse] = set()
        self.phone_clients: set[web.WebSocketResponse] = set()

        # STT engine instance
        self.stt = None
        self.stt_task: asyncio.Task | None = None
        self.is_listening = False

        # Text injector
        self.injector = None
        self._init_injector()

        # Web app
        self.app = web.Application()
        self._setup_routes()

    # ── Config ────────────────────────────────────────────────────────────────
    def _load_config(self) -> dict:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        MODELS_DIR.mkdir(parents=True, exist_ok=True)
        if CONFIG_FILE.exists():
            try:
                with CONFIG_FILE.open() as f:
                    data = json.load(f)
                    cfg = {**DEFAULT_CONFIG, **data}
                    return cfg
            except Exception as e:
                log.warning(f"Could not load config: {e}")
        return dict(DEFAULT_CONFIG)

    def _save_config(self):
        try:
            with CONFIG_FILE.open('w') as f:
                json.dump(self.config, f, indent=2)
        except Exception as e:
            log.warning(f"Could not save config: {e}")

    # ── Injector ──────────────────────────────────────────────────────────────
    def _init_injector(self):
        try:
            from injector.injector import TextInjector
            self.injector = TextInjector()
            log.info("Text injector initialized")
        except Exception as e:
            log.warning(f"Text injector unavailable: {e}")
            self.injector = None

    # ── Routes ────────────────────────────────────────────────────────────────
    def _setup_routes(self):
        self.app.router.add_get('/', self._handle_index)
        self.app.router.add_get('/phone', self._handle_phone)
        self.app.router.add_get('/status', self._handle_status)
        self.app.router.add_get('/ws', self._handle_ws_ui)
        self.app.router.add_get('/ws/phone', self._handle_ws_phone)

        # Serve static UI files
        ui_dir = Path(__file__).parent.parent / 'ui'
        if ui_dir.exists():
            self.app.router.add_static('/ui', ui_dir)

    async def _handle_index(self, request: web.Request) -> web.Response:
        raise web.HTTPFound('/phone')

    async def _handle_phone(self, request: web.Request) -> web.Response:
        ui_dir = Path(__file__).parent.parent / 'ui'
        phone_file = ui_dir / 'phone.html'

        if not phone_file.exists():
            return web.Response(text="<h1>phone.html not found</h1>", content_type='text/html')

        content = phone_file.read_text(encoding='utf-8')

        # Inject the server host so phone-client.js can connect back
        host = self._get_local_ip()
        port = str(self.port)
        # Replace the static JS file reference with inline-adjusted version
        content = content.replace(
            'src="js/phone-client.js"',
            f'src="/ui/js/phone-client.js?host={host}&port={port}"'
        )

        return web.Response(text=content, content_type='text/html')

    async def _handle_status(self, request: web.Request) -> web.Response:
        return web.json_response({
            'status': 'ok',
            'listening': self.is_listening,
            'lang': self.config.get('lang'),
            'engine': self.config.get('engine'),
            'ui_clients': len(self.ui_clients),
            'phone_clients': len(self.phone_clients),
            'platform': platform.system(),
        })

    # ── WebSocket — UI ────────────────────────────────────────────────────────
    async def _handle_ws_ui(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.ui_clients.add(ws)
        log.info(f"UI client connected ({len(self.ui_clients)} total)")

        # Send current status immediately
        await self._send_to_ws(ws, {
            'type': 'status',
            'state': 'listening' if self.is_listening else 'idle',
        })

        # Send QR code
        await self._send_qr_to_ws(ws)

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_ui_message(ws, msg.data)
                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
        except Exception as e:
            log.error(f"UI WS error: {e}")
        finally:
            self.ui_clients.discard(ws)
            log.info(f"UI client disconnected ({len(self.ui_clients)} remaining)")

        return ws

    async def _handle_ui_message(self, ws: web.WebSocketResponse, raw: str):
        try:
            msg = json.loads(raw)
        except Exception:
            log.warning(f"Bad message from UI: {raw[:100]}")
            return

        msg_type = msg.get('type', '')
        log.debug(f"UI message: {msg_type}")

        if msg_type == 'start_dictation':
            await self._start_dictation()
        elif msg_type == 'stop_dictation':
            await self._stop_dictation()
        elif msg_type == 'set_language':
            lang = msg.get('lang', 'fr')
            await self._set_language(lang)
        elif msg_type == 'set_engine':
            engine = msg.get('engine', 'vosk')
            await self._set_engine(engine)
        else:
            log.debug(f"Unknown UI message type: {msg_type}")

    # ── WebSocket — Phone ─────────────────────────────────────────────────────
    async def _handle_ws_phone(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        self.phone_clients.add(ws)
        log.info(f"Phone client connected ({len(self.phone_clients)} total)")

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._handle_phone_message(ws, msg.data)
                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                    break
        except Exception as e:
            log.error(f"Phone WS error: {e}")
        finally:
            self.phone_clients.discard(ws)
            log.info(f"Phone client disconnected ({len(self.phone_clients)} remaining)")

        return ws

    async def _handle_phone_message(self, ws: web.WebSocketResponse, raw: str):
        try:
            msg = json.loads(raw)
        except Exception:
            return

        if msg.get('type') == 'transcript' and msg.get('is_final'):
            text = msg.get('text', '').strip()
            if text:
                log.info(f"Phone transcript: {text!r}")
                # Inject into focused window
                await self._inject_text(text)
                # Broadcast to UI
                await self._broadcast_ui({
                    'type': 'transcript',
                    'text': text,
                    'is_final': True,
                    'source': 'phone',
                })
                # Confirm back to phone
                await self._send_to_ws(ws, {'type': 'injected', 'text': text})

    # ── Dictation control ─────────────────────────────────────────────────────
    async def _start_dictation(self):
        if self.is_listening:
            log.debug("Already listening")
            return

        log.info(f"Starting dictation (engine={self.config['engine']}, lang={self.config['lang']})")
        self.is_listening = True
        await self._broadcast_status('listening')

        # Start STT in background task
        self.stt_task = asyncio.create_task(self._run_stt())

    async def _stop_dictation(self):
        if not self.is_listening:
            return

        log.info("Stopping dictation")
        self.is_listening = False

        if self.stt:
            try:
                self.stt.stop()
            except Exception as e:
                log.warning(f"Error stopping STT: {e}")

        if self.stt_task and not self.stt_task.done():
            self.stt_task.cancel()
            try:
                await self.stt_task
            except asyncio.CancelledError:
                pass
            self.stt_task = None

        self.stt = None
        await self._broadcast_status('idle')

    async def _run_stt(self):
        engine_type = self.config.get('engine', 'vosk')
        lang = self.config.get('lang', 'fr')
        model_size = self.config.get('model_size', 'small')

        try:
            if engine_type == 'whisper':
                from stt.whisper_engine import WhisperEngine
                self.stt = WhisperEngine(
                    model_size=model_size,
                    lang=lang,
                )
            else:
                from stt.vosk_engine import VoskEngine
                self.stt = VoskEngine(
                    lang=lang,
                    model_size=model_size,
                    models_dir=str(MODELS_DIR),
                    on_download_progress=self._on_download_progress,
                )

            await self.stt.start(on_result=self._on_transcript)

        except asyncio.CancelledError:
            log.info("STT task cancelled")
            raise
        except Exception as e:
            log.error(f"STT error: {e}", exc_info=True)
            await self._broadcast_ui({
                'type': 'error',
                'message': f"Erreur STT: {e}",
            })
            self.is_listening = False
            await self._broadcast_status('idle')

    async def _on_transcript(self, text: str, is_final: bool):
        """Called by STT engine with recognized text."""
        if not text.strip():
            return

        log.info(f"Transcript ({'final' if is_final else 'interim'}): {text!r}")

        await self._broadcast_ui({
            'type': 'transcript',
            'text': text,
            'is_final': is_final,
            'source': 'mic',
        })

        if is_final:
            await self._inject_text(text)

    def _on_download_progress(self, model: str, progress: float, status: str, size: str = ''):
        """Called by VoskEngine during model download."""
        asyncio.get_event_loop().call_soon_threadsafe(
            asyncio.ensure_future,
            self._broadcast_ui({
                'type': 'model_download',
                'model': model,
                'progress': progress,
                'status': status,
                'size': size,
            })
        )

    # ── Config setters ────────────────────────────────────────────────────────
    async def _set_language(self, lang: str):
        log.info(f"Setting language: {lang}")
        was_listening = self.is_listening
        if was_listening:
            await self._stop_dictation()
        self.config['lang'] = lang
        self._save_config()
        if was_listening:
            await self._start_dictation()

    async def _set_engine(self, engine: str):
        if engine not in ('vosk', 'whisper'):
            log.warning(f"Unknown engine: {engine}")
            return
        log.info(f"Setting engine: {engine}")
        was_listening = self.is_listening
        if was_listening:
            await self._stop_dictation()
        self.config['engine'] = engine
        self._save_config()
        if was_listening:
            await self._start_dictation()

    # ── Text injection ────────────────────────────────────────────────────────
    async def _inject_text(self, text: str):
        if not self.injector:
            log.debug(f"No injector available, text would have been: {text!r}")
            return
        try:
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, self.injector.inject, text)
        except Exception as e:
            log.error(f"Injection error: {e}")

    # ── Broadcast helpers ─────────────────────────────────────────────────────
    async def _broadcast_ui(self, msg: dict):
        if not self.ui_clients:
            return
        dead = set()
        data = json.dumps(msg, ensure_ascii=False)
        for ws in list(self.ui_clients):
            try:
                await ws.send_str(data)
            except Exception:
                dead.add(ws)
        self.ui_clients -= dead

    async def _broadcast_status(self, state: str):
        await self._broadcast_ui({'type': 'status', 'state': state})

    async def _send_to_ws(self, ws: web.WebSocketResponse, msg: dict):
        try:
            await ws.send_str(json.dumps(msg, ensure_ascii=False))
        except Exception as e:
            log.debug(f"send_to_ws error: {e}")

    async def _send_qr_to_ws(self, ws: web.WebSocketResponse):
        ip = self._get_local_ip()
        url = f"http://{ip}:{self.port}/phone"
        svg = self._generate_qr_svg(url)
        await self._send_to_ws(ws, {
            'type': 'qr_code',
            'url': url,
            'svg': svg,
        })

    # ── QR code ───────────────────────────────────────────────────────────────
    def _generate_qr_svg(self, url: str) -> str:
        if segno is None:
            return ''
        try:
            import io
            qr = segno.make_qr(url, error='M')
            buf = io.StringIO()
            qr.save(buf, kind='svg', scale=3, dark='#000', light='#fff', xmldecl=False)
            return buf.getvalue()
        except Exception as e:
            log.warning(f"QR generation failed: {e}")
            return ''

    # ── Network helpers ───────────────────────────────────────────────────────
    def _get_local_ip(self) -> str:
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.connect(('8.8.8.8', 80))
                return s.getsockname()[0]
        except Exception:
            return '127.0.0.1'

    # ── Run ───────────────────────────────────────────────────────────────────
    async def run(self):
        runner = web.AppRunner(self.app, access_log=None)
        await runner.setup()
        site = web.TCPSite(runner, '0.0.0.0', self.port)
        await site.start()

        ip = self._get_local_ip()
        log.info(f"VoiceTyper Engine started on http://{ip}:{self.port}")
        log.info(f"Phone URL: http://{ip}:{self.port}/phone")

        # Handle OS signals
        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        def _signal_handler():
            log.info("Shutdown signal received")
            stop_event.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _signal_handler)
            except (NotImplementedError, OSError):
                # Windows doesn't support add_signal_handler for all signals
                pass

        try:
            await stop_event.wait()
        except asyncio.CancelledError:
            pass
        finally:
            log.info("Shutting down…")
            if self.is_listening:
                await self._stop_dictation()
            await runner.cleanup()


# ─── Entry point ──────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description='VoiceTyper Engine')
    parser.add_argument('--port', type=int, default=7523, help='WebSocket/HTTP port')
    parser.add_argument('--debug', action='store_true', help='Enable debug logging')
    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    engine = VoiceTyperEngine(port=args.port)

    try:
        asyncio.run(engine.run())
    except KeyboardInterrupt:
        log.info("Interrupted by user")


if __name__ == '__main__':
    main()
