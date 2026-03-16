"""
faster-whisper STT Engine — High accuracy, GPU-accelerated if available.
Uses VAD (Voice Activity Detection) for real-time segmentation.

Requires: pip install faster-whisper sounddevice numpy
Optional GPU: pip install nvidia-cublas-cu12 nvidia-cudnn-cu12

Model sizes and RAM usage:
  tiny    ~ 75 MB   (fastest)
  base    ~ 145 MB
  small   ~ 461 MB  (good balance)
  medium  ~ 1.5 GB  (high quality)
  large-v3 ~3 GB   (best quality)
"""

import asyncio
import logging
import queue
import threading
from typing import Callable, Awaitable, Optional

# numpy imported lazily inside methods to avoid pulling it at module load time
# (keeps the PyInstaller binary lean when whisper engine is not used)

log = logging.getLogger('voicetyper.whisper')

OnResultCallback = Callable[[str, bool], Awaitable[None]]


class WhisperEngine:
    """
    Speech recognition engine powered by faster-whisper.
    Buffers audio, runs VAD, transcribes segments in real-time.
    """

    SAMPLE_RATE = 16000
    CHUNK_DURATION = 0.3        # seconds per audio chunk
    MAX_BUFFER_DURATION = 30.0  # max buffer before forced transcription
    SILENCE_THRESHOLD = 0.01    # RMS threshold below which audio is "silence"
    SILENCE_DURATION = 1.0      # seconds of silence to trigger transcription

    def __init__(
        self,
        model_size: str = 'small',
        lang: Optional[str] = None,
        device: str = 'auto',
        compute_type: str = 'default',
        device_id: int = None,
    ):
        self.model_size = model_size
        # 'fr-FR' → 'fr', None stays None (auto-detect)
        self.lang = lang.split('-')[0].lower() if lang else None
        self.device = device
        self.compute_type = compute_type
        self.device_id = device_id

        self._stop_event = threading.Event()
        self._audio_queue: queue.Queue = queue.Queue()
        self._model = None

    # ── Public API ────────────────────────────────────────────────────────────
    async def start(self, on_result: OnResultCallback):
        """Start microphone capture and real-time transcription."""
        import sounddevice as sd

        # Load model
        log.info(f"Loading Whisper model: {self.model_size} (device={self.device})")
        await asyncio.get_event_loop().run_in_executor(None, self._load_model)
        log.info("Whisper model loaded")

        self._stop_event.clear()

        loop = asyncio.get_event_loop()

        # Start capture thread
        audio_thread = threading.Thread(
            target=self._audio_capture_thread,
            daemon=True,
        )
        audio_thread.start()

        # Process loop
        try:
            await self._process_audio_loop(on_result, loop)
        finally:
            self._stop_event.set()

    def stop(self):
        self._stop_event.set()

    # ── Internals ─────────────────────────────────────────────────────────────
    def _load_model(self):
        try:
            from faster_whisper import WhisperModel
        except ImportError:
            raise RuntimeError(
                "faster-whisper not installed.\n"
                "Run: pip install faster-whisper"
            )

        # Device selection
        device = self.device
        compute_type = self.compute_type

        if device == 'auto':
            try:
                import torch
                device = 'cuda' if torch.cuda.is_available() else 'cpu'
            except ImportError:
                device = 'cpu'

        if compute_type == 'default':
            compute_type = 'float16' if device == 'cuda' else 'int8'

        log.info(f"Whisper device={device}, compute={compute_type}")

        self._model = WhisperModel(
            self.model_size,
            device=device,
            compute_type=compute_type,
        )

    def _audio_capture_thread(self):
        """Capture microphone in chunks and put into queue."""
        import sounddevice as sd

        chunk_samples = int(self.SAMPLE_RATE * self.CHUNK_DURATION)

        def _callback(indata, frames, time_info, status):
            if status:
                log.debug(f"Audio status: {status}")
            if not self._stop_event.is_set():
                self._audio_queue.put_nowait(indata[:, 0].copy())

        selected_device = self.device_id  # None = system default

        try:
            with sd.InputStream(
                device=selected_device,
                samplerate=self.SAMPLE_RATE,
                channels=1,
                dtype='float32',
                blocksize=chunk_samples,
                callback=_callback,
            ):
                log.info("Whisper microphone capture started")
                self._stop_event.wait()
        except Exception as e:
            log.error(f"Whisper audio capture error: {e}")

        log.info("Whisper microphone capture stopped")

    async def _process_audio_loop(self, on_result: OnResultCallback, loop: asyncio.AbstractEventLoop):
        """
        Buffer audio, detect silence, then run Whisper on accumulated buffer.
        Yields partial (interim) results as '…' and final results when silence detected.
        """
        import numpy as np
        audio_buffer: list = []
        silence_chunks = 0
        silence_threshold_chunks = int(self.SILENCE_DURATION / self.CHUNK_DURATION)
        max_buffer_chunks = int(self.MAX_BUFFER_DURATION / self.CHUNK_DURATION)

        while not self._stop_event.is_set():
            try:
                chunk = await loop.run_in_executor(
                    None, lambda: self._audio_queue.get(timeout=0.1)
                )
            except queue.Empty:
                continue
            except Exception:
                break

            rms = float(np.sqrt(np.mean(chunk ** 2)))

            if rms < self.SILENCE_THRESHOLD:
                silence_chunks += 1
            else:
                silence_chunks = 0
                audio_buffer.append(chunk)
                # Send interim signal
                if audio_buffer:
                    await on_result('…', False)

            # Transcribe on silence or max buffer
            should_transcribe = (
                (silence_chunks >= silence_threshold_chunks and audio_buffer) or
                (len(audio_buffer) >= max_buffer_chunks)
            )

            if should_transcribe and audio_buffer:
                audio_array = np.concatenate(audio_buffer)
                audio_buffer = []
                silence_chunks = 0

                text = await loop.run_in_executor(
                    None, self._transcribe, audio_array
                )

                if text:
                    await on_result(text, True)
                else:
                    # Clear interim
                    await on_result('', False)

        # Final transcription of remaining buffer
        if audio_buffer:
            audio_array = np.concatenate(audio_buffer)
            text = await loop.run_in_executor(None, self._transcribe, audio_array)
            if text:
                await on_result(text, True)

    def _transcribe(self, audio) -> str:
        """Blocking transcription call (run in executor)."""
        if self._model is None:
            return ''

        try:
            kwargs = {
                'language': self.lang,
                'vad_filter': True,
                'vad_parameters': {
                    'min_silence_duration_ms': 500,
                    'threshold': 0.3,
                },
                'beam_size': 5,
                'best_of': 5,
                'temperature': 0.0,
                'word_timestamps': False,
                'condition_on_previous_text': False,
            }

            segments, _info = self._model.transcribe(audio, **kwargs)
            text_parts = [seg.text.strip() for seg in segments if seg.text.strip()]
            return ' '.join(text_parts)

        except Exception as e:
            log.error(f"Whisper transcription error: {e}")
            return ''
