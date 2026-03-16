"""
Vosk STT Engine — Offline, fast, multilingual.
No internet required after model download.
Downloads model automatically on first use.
"""

import asyncio
import json
import logging
import os
import queue
import threading
import urllib.request
import zipfile
from pathlib import Path
from typing import Callable, Awaitable, Optional

log = logging.getLogger('voicetyper.vosk')

# ─── Model registry ───────────────────────────────────────────────────────────
VOSK_MODELS: dict[str, dict] = {
    'fr': {
        'small': ('vosk-model-small-fr-0.22',
                  'https://alphacephei.com/vosk/models/vosk-model-small-fr-0.22.zip',
                  '41MB'),
        'large': ('vosk-model-fr-0.6-linto-2.2.0',
                  'https://alphacephei.com/vosk/models/vosk-model-fr-0.6-linto-2.2.0.zip',
                  '1.4GB'),
    },
    'en': {
        'small': ('vosk-model-small-en-us-0.15',
                  'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip',
                  '40MB'),
        'large': ('vosk-model-en-us-0.22',
                  'https://alphacephei.com/vosk/models/vosk-model-en-us-0.22.zip',
                  '1.8GB'),
    },
    'es': {
        'small': ('vosk-model-small-es-0.42',
                  'https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip',
                  '39MB'),
    },
    'de': {
        'small': ('vosk-model-small-de-0.15',
                  'https://alphacephei.com/vosk/models/vosk-model-small-de-0.15.zip',
                  '45MB'),
    },
    'it': {
        'small': ('vosk-model-small-it-0.22',
                  'https://alphacephei.com/vosk/models/vosk-model-small-it-0.22.zip',
                  '48MB'),
    },
    'pt': {
        'small': ('vosk-model-small-pt-0.3',
                  'https://alphacephei.com/vosk/models/vosk-model-small-pt-0.3.zip',
                  '31MB'),
    },
    'ru': {
        'small': ('vosk-model-small-ru-0.22',
                  'https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip',
                  '45MB'),
    },
    'zh': {
        'small': ('vosk-model-small-cn-0.22',
                  'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip',
                  '42MB'),
    },
    'ja': {
        'small': ('vosk-model-small-ja-0.22',
                  'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip',
                  '48MB'),
    },
    'ar': {
        'small': ('vosk-model-ar-mgb2-0.4',
                  'https://alphacephei.com/vosk/models/vosk-model-ar-mgb2-0.4.zip',
                  '318MB'),
    },
}

OnResultCallback = Callable[[str, bool], Awaitable[None]]


class VoskEngine:
    """
    Offline speech recognition engine powered by Vosk.

    Usage:
        engine = VoskEngine(lang='fr', model_size='small', models_dir='/path/to/models')
        await engine.start(on_result=my_callback)
        # ...later...
        engine.stop()
    """

    SAMPLE_RATE = 16000

    def __init__(
        self,
        lang: str = 'fr',
        model_size: str = 'small',
        models_dir: Optional[str] = None,
        on_download_progress: Optional[Callable] = None,
    ):
        self.lang = lang.split('-')[0].lower()  # 'fr-FR' → 'fr'
        self.model_size = model_size
        self.models_dir = Path(models_dir) if models_dir else Path.home() / '.voicetyper' / 'models'
        self.on_download_progress = on_download_progress
        self._stop_event = threading.Event()
        self._audio_queue: queue.Queue = queue.Queue()
        self._stream = None
        self._recognizer = None
        self._model = None

    # ── Public API ────────────────────────────────────────────────────────────
    async def start(self, on_result: OnResultCallback):
        """Start microphone capture and streaming transcription."""
        import sounddevice as sd

        # Ensure model is available
        model_path = await asyncio.get_event_loop().run_in_executor(
            None, self._ensure_model
        )

        # Load Vosk model
        log.info(f"Loading Vosk model from {model_path}")
        await asyncio.get_event_loop().run_in_executor(None, self._load_model, model_path)
        log.info("Vosk model loaded")

        self._stop_event.clear()

        # Start audio stream in a thread
        loop = asyncio.get_event_loop()
        audio_thread = threading.Thread(
            target=self._audio_capture_thread,
            args=(loop,),
            daemon=True,
        )
        audio_thread.start()

        # Process audio queue in async loop
        try:
            await self._process_audio_loop(on_result)
        finally:
            self._stop_event.set()
            if self._stream:
                try:
                    self._stream.stop()
                    self._stream.close()
                except Exception:
                    pass

    def stop(self):
        """Signal the engine to stop."""
        self._stop_event.set()

    # ── Internals ─────────────────────────────────────────────────────────────
    def _find_bundled_model(self, model_name: str) -> Optional[Path]:
        """Look for a pre-bundled model in known locations (packaged AppImage or dev)."""
        candidates = []

        # 1. Env variable set by Electron at launch
        env_path = os.environ.get('VOICETYPER_MODELS_PATH')
        if env_path:
            candidates.append(Path(env_path) / model_name)

        # 2. Alongside the frozen binary (PyInstaller: sys.executable dir)
        import sys
        if getattr(sys, 'frozen', False):
            exe_dir = Path(sys.executable).parent
            candidates.append(exe_dir / 'models' / model_name)
            candidates.append(exe_dir.parent / 'models' / model_name)

        # 3. Relative to this source file (dev mode)
        src_root = Path(__file__).parent.parent.parent
        candidates.append(src_root / 'models' / model_name)

        for c in candidates:
            if c.exists():
                log.info(f"Found bundled model at {c}")
                return c
        return None

    def _ensure_model(self) -> str:
        """Download and extract model if not present. Returns model directory path."""
        lang_models = VOSK_MODELS.get(self.lang)
        if not lang_models:
            # Fallback to English
            log.warning(f"No Vosk model for language '{self.lang}', falling back to English")
            lang_models = VOSK_MODELS['en']

        size_models = lang_models.get(self.model_size) or lang_models.get('small')
        if not size_models:
            raise RuntimeError(f"No model available for lang={self.lang}, size={self.model_size}")

        model_name, model_url, model_size_str = size_models

        # Check for bundled model first (no download needed)
        bundled = self._find_bundled_model(model_name)
        if bundled:
            return str(bundled)

        model_dir = self.models_dir / model_name

        if model_dir.exists():
            log.info(f"Model already present at {model_dir}")
            return str(model_dir)

        # Download
        log.info(f"Downloading model {model_name} ({model_size_str}) from {model_url}")
        self.models_dir.mkdir(parents=True, exist_ok=True)
        zip_path = self.models_dir / f"{model_name}.zip"

        self._download_model(model_url, zip_path, model_name, model_size_str)

        # Extract
        log.info(f"Extracting {zip_path}…")
        if self.on_download_progress:
            self.on_download_progress(model_name, 95.0, 'extracting', model_size_str)

        with zipfile.ZipFile(zip_path, 'r') as zf:
            zf.extractall(self.models_dir)

        zip_path.unlink(missing_ok=True)

        if self.on_download_progress:
            self.on_download_progress(model_name, 100.0, 'done', model_size_str)

        log.info(f"Model ready at {model_dir}")
        return str(model_dir)

    def _download_model(self, url: str, dest: Path, model_name: str, size_str: str):
        """Download with progress reporting."""

        def _reporthook(count, block_size, total_size):
            if total_size > 0 and self.on_download_progress:
                progress = min(count * block_size / total_size * 100, 95.0)
                self.on_download_progress(model_name, progress, 'downloading', size_str)

        if self.on_download_progress:
            self.on_download_progress(model_name, 0.0, 'downloading', size_str)

        urllib.request.urlretrieve(url, dest, _reporthook)

    def _load_model(self, model_path: str):
        """Load Vosk model (blocking, run in executor)."""
        try:
            from vosk import Model, KaldiRecognizer, SetLogLevel
            SetLogLevel(-1)  # Suppress Vosk logs
            self._model = Model(model_path)
            self._recognizer = KaldiRecognizer(self._model, self.SAMPLE_RATE)
            self._recognizer.SetWords(True)
        except ImportError:
            raise RuntimeError("vosk package not installed. Run: pip install vosk")

    def _audio_capture_thread(self, loop: asyncio.AbstractEventLoop):
        """Capture microphone audio and put chunks in queue."""
        import sounddevice as sd
        import numpy as np

        BLOCK_SIZE = 4000  # ~250ms at 16kHz

        def _callback(indata, frames, time_info, status):
            if status:
                log.debug(f"Audio status: {status}")
            if not self._stop_event.is_set():
                audio_bytes = (indata[:, 0] * 32767).astype('int16').tobytes()
                self._audio_queue.put_nowait(audio_bytes)

        try:
            with sd.InputStream(
                samplerate=self.SAMPLE_RATE,
                channels=1,
                dtype='float32',
                blocksize=BLOCK_SIZE,
                callback=_callback,
            ):
                log.info("Microphone capture started")
                self._stop_event.wait()
        except Exception as e:
            log.error(f"Audio capture error: {e}")
            asyncio.run_coroutine_threadsafe(
                asyncio.sleep(0),  # Wake up the async loop
                loop,
            )

        log.info("Microphone capture stopped")

    async def _process_audio_loop(self, on_result: OnResultCallback):
        """Consume audio queue and feed to Vosk recognizer."""
        loop = asyncio.get_event_loop()

        while not self._stop_event.is_set():
            # Drain queue with brief timeout so we can check stop_event
            try:
                chunk = await loop.run_in_executor(
                    None, lambda: self._audio_queue.get(timeout=0.1)
                )
            except queue.Empty:
                continue
            except Exception:
                break

            if not self._recognizer:
                continue

            try:
                accepted = await loop.run_in_executor(
                    None, self._recognizer.AcceptWaveform, chunk
                )

                if accepted:
                    result = json.loads(self._recognizer.Result())
                    text = result.get('text', '').strip()
                    if text:
                        await on_result(text, True)
                else:
                    partial = json.loads(self._recognizer.PartialResult())
                    text = partial.get('partial', '').strip()
                    if text:
                        await on_result(text, False)

            except Exception as e:
                log.error(f"Vosk processing error: {e}")

        # Flush final result
        if self._recognizer:
            try:
                result = json.loads(self._recognizer.FinalResult())
                text = result.get('text', '').strip()
                if text:
                    await on_result(text, True)
            except Exception:
                pass
