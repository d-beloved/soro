"""ffmpeg in/out: any WhatsApp audio -> 16 kHz mono float32 for Whisper; TTS samples -> OGG/OPUS voice note."""

from __future__ import annotations

import subprocess

import numpy as np

ASR_SAMPLE_RATE = 16_000


def _ffmpeg(args: list[str], data: bytes) -> bytes:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", *args],
        input=data,
        capture_output=True,
        check=False,
    )
    if proc.returncode != 0:
        raise ValueError(f"ffmpeg failed: {proc.stderr.decode(errors='replace')[:300]}")
    return proc.stdout


def decode_to_16k(data: bytes) -> np.ndarray:
    raw = _ffmpeg(["-i", "pipe:0", "-ac", "1", "-ar", str(ASR_SAMPLE_RATE), "-f", "f32le", "pipe:1"], data)
    return np.frombuffer(raw, dtype=np.float32).copy()


def encode_voice_note(samples: np.ndarray, sample_rate: int) -> bytes:
    """WhatsApp voice notes must be OGG container + OPUS codec, mono (max 16 MB)."""
    pcm = np.clip(samples.astype(np.float32), -1.0, 1.0).tobytes()
    return _ffmpeg(
        [
            "-f", "f32le", "-ar", str(sample_rate), "-ac", "1", "-i", "pipe:0",
            "-c:a", "libopus", "-b:a", "32k", "-application", "voip",
            "-f", "ogg", "pipe:1",
        ],
        pcm,
    )
