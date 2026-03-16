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
VOSK_MODELS = {
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
        device_id: Optional[int] = None,
    ):
        self.lang = lang.split('-')[0].lower()
        self.model_size = model_size
        self.models_dir = Path(models_dir) if models_dir else Path.home() / '.voicetyper' / 'models'
        self.on_download_progress = on_download_progress
        self.device_id = device_id
        self._stop_event = threading.Event()
        self._audio_queue = queue.Queue()
        self._stream = None
        self._recognizer = None
        self._model = None

    # ── Public API ────────────────────────────────────────────────────────────
    async def start(self, on_result: OnResultCallback):
        """Start microphone capture and streaming transcription."""
        # FIX: import sounddevice here with proper error message
        try:
            import sounddevice as sd
        except ImportError:
            raise RuntimeError(
                "sounddevice not installed. Run: pip install sounddevice\n"
                "On Windows, you may also need to install the VC++ redistributable."
            )
        except OSError as e:
            raise RuntimeError(
                f"sounddevice failed to load audio backend: {e}\n"
                "On Linux, install portaudio: sudo apt-get install libportaudio2\n"
                "On Windows, ensure VC++ redistributable is installed."
            )

        # Ensure model is available
        model_path = await asyncio.get_event_loop().run_in_executor(
            None, self._ensure_model
        )

        # Load Vosk model
        log.info(f"Loading Vosk model from {model_path}")
        await asyncio.get_event_loop().run_in_executor(None, self._load_model, model_path)
        log.info("Vosk model loaded")

        self._stop_event.clear()

        loop = asyncio.get_event_loop()
        audio_thread = threading.Thread(
            target=self._audio_capture_thread,
            args=(loop,),
            daemon=True,
        )
        audio_thread.start()

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
        """Look for a pre-bundled model in known locations."""
        import sys as _sys
        candidates = []

        # 1. Environment variable (set by Electron main.js)
        env_path = os.environ.get('VOICETYPER_MODELS_PATH')
        if env_path:
            candidates.append(Path(env_path) / model_name)
            candidates.append(Path(env_path))  # maybe env points directly to model dir

        # 2. VOICETYPER_RESOURCES_PATH (process.resourcesPath from Electron)
        res_path = os.environ.get('VOICETYPER_RESOURCES_PATH')
        if res_path:
            candidates.append(Path(res_path) / 'models' / model_name)
            candidates.append(Path(res_path) / 'models')
            candidates.append(Path(res_path) / 'engine' / 'models' / model_name)

        if getattr(_sys, 'frozen', False):
            exe_dir = Path(_sys.executable).parent
            # --onedir: exe is in engine/ folder, models in ../models/
            candidates.append(exe_dir / 'models' / model_name)
            candidates.append(exe_dir / '..' / 'models' / model_name)
            candidates.append(exe_dir.parent / 'models' / model_name)
            # Electron packaged: resources/models/
            candidates.append(exe_dir / '..' / 'resources' / 'models' / model_name)
            candidates.append(exe_dir.parent / 'resources' / 'models' / model_name)
            # Electron NSIS install: resources at 2 levels up
            candidates.append(exe_dir / '..' / '..' / 'models' / model_name)
            candidates.append(exe_dir / '..' / '..' / 'resources' / 'models' / model_name)

        # Dev mode
        src_root = Path(__file__).parent.parent.parent
        candidates.append(src_root / 'models' / model_name)

        # User home fallback
        candidates.append(Path.home() / '.voicetyper' / 'models' / model_name)

        for c in candidates:
            try:
                resolved = c.resolve()
                exists = resolved.exists()
                is_dir = resolved.is_dir() if exists else False
                log.info("Checking model path: %s -> exists=%s is_dir=%s", resolved, exists, is_dir)
                if exists and is_dir:
                    # Verify the model is not corrupted — check for key files
                    mdl_file = resolved / 'am' / 'final.mdl'
                    conf_file = resolved / 'conf' / 'mfcc.conf'
                    if mdl_file.exists() and conf_file.exists():
                        mdl_size = mdl_file.stat().st_size
                        log.info("Model validated: final.mdl=%d bytes at %s", mdl_size, resolved)
                        if mdl_size > 1000000:  # Must be > 1MB
                            return resolved
                        else:
                            log.warning("Model file too small (%d bytes), likely corrupted", mdl_size)
                    else:
                        log.warning("Model directory exists but missing key files: am/final.mdl=%s conf/mfcc.conf=%s",
                                    mdl_file.exists(), conf_file.exists())
            except Exception as e:
                log.debug("Error checking path %s: %s", c, e)

        log.warning("No valid bundled model found. Searched %d paths.", len(candidates))
        return None

    def _ensure_model(self) -> str:
        """Download and extract model if not present. Returns model directory path."""
        lang_models = VOSK_MODELS.get(self.lang)
        if not lang_models:
            log.warning(f"No Vosk model for language '{self.lang}', falling back to English")
            lang_models = VOSK_MODELS['en']

        size_models = lang_models.get(self.model_size) or lang_models.get('small')
        if not size_models:
            raise RuntimeError(f"No model available for lang={self.lang}, size={self.model_size}")

        model_name, model_url, model_size_str = size_models

        bundled = self._find_bundled_model(model_name)
        if bundled:
            return str(bundled)

        model_dir = self.models_dir / model_name

        if model_dir.exists():
            log.info(f"Model already present at {model_dir}")
            return str(model_dir)

        log.info(f"Downloading model {model_name} ({model_size_str}) from {model_url}")
        self.models_dir.mkdir(parents=True, exist_ok=True)
        zip_path = self.models_dir / f"{model_name}.zip"

        try:
            self._download_model(model_url, zip_path, model_name, model_size_str)
        except Exception as e:
            # FIX: clean up partial download on error
            if zip_path.exists():
                try:
                    zip_path.unlink()
                except Exception:
                    pass
            if self.on_download_progress:
                self.on_download_progress(model_name, 0, 'error', model_size_str)
            raise RuntimeError(f"Model download failed: {e}")

        log.info(f"Extracting {zip_path}...")
        if self.on_download_progress:
            self.on_download_progress(model_name, 95.0, 'extracting', model_size_str)

        try:
            with zipfile.ZipFile(zip_path, 'r') as zf:
                zf.extractall(self.models_dir)
        except Exception as e:
            # FIX: clean up corrupted extraction
            if model_dir.exists():
                import shutil
                try:
                    shutil.rmtree(model_dir)
                except Exception:
                    pass
            raise RuntimeError(f"Model extraction failed: {e}")
        finally:
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
            SetLogLevel(-1)
            # Fix: Vosk/Kaldi can fail with long Windows paths
            import platform
            if platform.system() == 'Windows':
                try:
                    import ctypes
                    buf = ctypes.create_unicode_buffer(512)
                    ctypes.windll.kernel32.GetShortPathNameW(model_path, buf, 512)
                    short_path = buf.value
                    if short_path:
                        log.info("Using short path: %s -> %s", model_path, short_path)
                        model_path = short_path
                except Exception as e:
                    log.debug("Short path failed: %s", e)
            log.info("Loading Vosk model from: %s", model_path)
            self._model = Model(model_path)
            self._recognizer = KaldiRecognizer(self._model, self.SAMPLE_RATE)
            self._recognizer.SetWords(True)
        except ImportError:
            raise RuntimeError("vosk package not installed. Run: pip install vosk")

    def _audio_capture_thread(self, loop):
        """Capture microphone audio and put chunks in queue."""
        import sounddevice as sd
        import numpy as np

        BLOCK_SIZE = 4000  # ~250ms at 16kHz

        def _callback(indata, frames, time_info, status):
            if status:
                log.debug(f"Audio status: {status}")
            if not self._stop_event.is_set():
                audio_bytes = (indata[:, 0] * 32767).astype(np.int16).tobytes()
                try:
                    self._audio_queue.put_nowait(audio_bytes)
                except queue.Full:
                    pass  # Drop frame if queue is full

        selected_device = self.device_id  # None = system default
        log.info(f"Opening audio input device: {selected_device if selected_device is not None else 'system default'}")

        try:
            with sd.InputStream(
                device=selected_device,
                samplerate=self.SAMPLE_RATE,
                channels=1,
                dtype='float32',
                blocksize=BLOCK_SIZE,
                callback=_callback,
            ) as stream:
                self._stream = stream
                log.info("Microphone capture started")
                self._stop_event.wait()
        except sd.PortAudioError as e:
            log.error(f"PortAudio error: {e}")
            log.error("Make sure a microphone is connected and accessible.")
            # FIX: notify the async side about the error
            asyncio.run_coroutine_threadsafe(
                self._notify_audio_error(str(e)),
                loop,
            )
        except Exception as e:
            log.error(f"Audio capture error: {e}")

        log.info("Microphone capture stopped")

    async def _notify_audio_error(self, error_msg: str):
        """Placeholder — the STT task will detect no audio and time out."""
        pass

    async def _process_audio_loop(self, on_result: OnResultCallback):
        """Consume audio queue and feed to Vosk recognizer."""
        loop = asyncio.get_event_loop()
        consecutive_empty = 0

        while not self._stop_event.is_set():
            try:
                chunk = await loop.run_in_executor(
                    None, lambda: self._audio_queue.get(timeout=0.2)
                )
                consecutive_empty = 0
            except queue.Empty:
                consecutive_empty += 1
                # FIX: if no audio for 30 seconds, something is wrong
                if consecutive_empty > 150:  # 150 * 0.2s = 30s
                    log.warning("No audio received for 30 seconds — microphone may be disconnected")
                    consecutive_empty = 0
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
