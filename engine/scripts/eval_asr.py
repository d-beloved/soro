"""Word error rate of the NCAIR ASR models on real trader voice notes (for the technical documentation).

Put recordings in engine/eval/<lang>/ (any format ffmpeg reads) and a engine/eval/<lang>/transcripts.csv
with columns: file,text   (the text is what was actually said, typed by a human).

  ENGINE_URL=... ENGINE_TOKEN=... uv run --extra ml python scripts/eval_asr.py
Prints WER per language and writes engine/eval/results.csv (gitignored: voice data stays local).
"""

from __future__ import annotations

import csv
import os
import time
from pathlib import Path

import httpx
import jiwer

EVAL = Path(__file__).resolve().parents[1] / "eval"
norm = jiwer.Compose([jiwer.ToLowerCase(), jiwer.RemovePunctuation(), jiwer.RemoveMultipleSpaces(), jiwer.Strip()])


def main() -> None:
    url = os.environ.get("ENGINE_URL", "http://localhost:8000").rstrip("/")
    headers = {"Authorization": f"Bearer {os.environ['ENGINE_TOKEN']}"}
    rows = []
    with httpx.Client(timeout=180, headers=headers) as client:
        for lang_dir in sorted(p for p in EVAL.iterdir() if p.is_dir()):
            refs, hyps = [], []
            for rec in csv.DictReader((lang_dir / "transcripts.csv").open()):
                t0 = time.perf_counter()
                r = client.post(f"{url}/transcribe?lang={lang_dir.name}", content=(lang_dir / rec["file"]).read_bytes())
                r.raise_for_status()
                hyp = r.json()["text"]
                ms = int((time.perf_counter() - t0) * 1000)
                refs.append(norm(rec["text"]))
                hyps.append(norm(hyp))
                rows.append({"lang": lang_dir.name, "file": rec["file"], "reference": rec["text"], "hypothesis": hyp, "ms": ms})
            if refs:
                print(f"{lang_dir.name}: WER {jiwer.wer(refs, hyps):.1%} on {len(refs)} clips")
    with (EVAL / "results.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["lang", "file", "reference", "hypothesis", "ms"])
        w.writeheader()
        w.writerows(rows)


if __name__ == "__main__":
    main()
