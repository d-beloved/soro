"""YarnGPT2 text-to-speech (Nigerian-accented English, Yoruba, Igbo, Hausa)."""

from __future__ import annotations

import sys
import threading

import numpy as np

from .config import TTS_LANG, TTS_REPO, TTS_SAMPLE_RATE, TTS_VOICE, WAV_CKPT, WAV_CONFIG, YARNGPT_PARENT, Lang
from .text import clean_for_speech, split_sentences

_GAP = np.zeros(int(TTS_SAMPLE_RATE * 0.18), dtype=np.float32)


class TTS:
    def __init__(self):
        import torch
        from transformers import AutoModelForCausalLM

        sys.path.insert(0, str(YARNGPT_PARENT))
        from yarngpt.audiotokenizer import AudioTokenizerV2  # cloned repo, pinned in config.YARNGPT_COMMIT

        # YarnGPT picks CUDA if available, else CPU (no MPS support).
        self._tok = AudioTokenizerV2(TTS_REPO, str(WAV_CKPT), str(WAV_CONFIG))
        self._model = AutoModelForCausalLM.from_pretrained(TTS_REPO, torch_dtype="auto").to(self._tok.device)
        self._model.eval()
        self._torch = torch
        self._lock = threading.Lock()  # the tokenizer keeps per-call state (input_length)

    def speak(self, text: str, lang: Lang) -> np.ndarray:
        pieces: list[np.ndarray] = []
        for chunk in split_sentences(clean_for_speech(text)):
            with self._lock, self._torch.inference_mode():
                prompt = self._tok.create_prompt(chunk, lang=TTS_LANG[lang], speaker_name=TTS_VOICE[lang])
                input_ids = self._tok.tokenize_prompt(prompt)
                output = self._model.generate(
                    input_ids=input_ids, temperature=0.1, repetition_penalty=1.1, max_length=4000
                )
                codes = self._tok.get_codes(output)
                audio = self._tok.get_audio(codes)
            pieces.extend([audio.squeeze().float().numpy(), _GAP])
        if not pieces:
            raise ValueError("nothing speakable in text")
        return np.concatenate(pieces)

    sample_rate = TTS_SAMPLE_RATE
