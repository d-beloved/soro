# Roadmap

Sọ̀rọ̀ is one product: a WhatsApp money assistant. Most of the code underneath it is general. It turns a voice note in a Nigerian language into a transcript, then into a structured intent, then into an action, then into a spoken reply. This roadmap turns that general part into an open toolkit, so a cooperative, a clinic or a school can build its own voice assistant in Nigerian languages, with models it chooses, on hardware it controls. Sọ̀rọ̀ then depends on the toolkit like any other user.

Status: **done** is in this repo now, **next** is being worked on, **planned** is not started.

## 1. Swappable models

Every model is a backend behind a small interface, chosen in a profile rather than in code.

- **LLM** (**done**, minimal). `ChatModel` in [engine/soro_engine/llm.py](engine/soro_engine/llm.py) is the interface. The one backend so far is llama.cpp with any GGUF, and JSON schemas are enforced by its grammar. `SORO_LLM` picks a profile from `LLM_PROFILES` in [config.py](engine/soro_engine/config.py). Two profiles exist: `n-atlas` (the default) and `qwen3-8b` (Apache-2.0). [scripts/eval_router.py](engine/scripts/eval_router.py) scores any profile on the router's labelled examples. Results: [docs/ROUTER_MODELS.md](docs/ROUTER_MODELS.md).
- **LLM** (**next**). An OpenAI-compatible backend (llama-server, vLLM, Ollama), and a test that fails when a backend can't enforce the router schema.
- **ASR** (**planned**). Today's models are the NCAIR Whisper fine-tunes, under a research and innovation licence. Candidates with permissive licences are Whisper large-v3 and turbo (MIT), Meta Omnilingual ASR (licence to verify), and community fine-tunes with clear licences. The language-detection thresholds are tuned for the NCAIR models today, so they move into each profile.
- **TTS** (**planned**). OmniVoice and its Yorùbá fine-tune (Apache-2.0) behind the interface. YarnGPT2 (Apache-2.0) is the second backend, and it has already been benchmarked against OmniVoice.

Profiles:

| Profile | What | Status |
|---|---|---|
| `n-atlas` | N-ATLaS, NCAIR ASR and OmniVoice, as Sọ̀rọ̀ runs today | done |
| `open` | Every model under a permissive licence, with no user cap | planned |
| `cpu` | Small models for a machine without a GPU, including Apple Silicon | planned |

## 2. Toolkit and product split

- **Toolkit** (planned, Apache-2.0):
  - the engine and its backends;
  - the gateway's pipeline core (voice note → transcript → intent → action → voice reply);
  - the privacy defaults;
  - the self-host profiles;
  - the docs.
- **Sọ̀rọ̀** keeps what is specific to it:
  - the bookkeeping domain;
  - the curated tips;
  - referrals;
  - its branding;
  - its hosting.
- **Domain packs** (planned). The router's intents, schema, few-shot examples and categories are Python constants in [prompts.py](engine/soro_engine/prompts.py) today. They move into one data file per domain, so a new domain is a new pack, not new code. The bookkeeping pack comes first. The leave-one-out check runs on any pack.

## 3. Nigerian-language amounts as a library

[numwords.py](engine/soro_engine/numwords.py) and [amounts.py](engine/soro_engine/amounts.py) read amounts in several forms:

- digits;
- "5k";
- English number words;
- Yorùbá, Hausa and Igbo number words, including common ASR mis-hearings.

They have round-trip tests for every Yorùbá amount. **Planned:** publish them as a standalone package with their tests.

## 4. An open evaluation set

**Planned.** A set of short spoken utterances about everyday money in:

- Pidgin;
- Yorùbá;
- Hausa;
- Igbo;
- Nigerian English.

It includes code-switching, such as English amounts inside a Yorùbá sentence. Each utterance is labelled with its transcript, language(s), intent, amount and item.

**Metrics:**
- ASR word error rate;
- intent accuracy;
- amount exact-match;
- TTS round-trip WER;

reported per backend.

**Recording:**
- It is a separate, paid, opt-in programme with written consent in each language.
- No phone numbers are collected, and contributors can withdraw.
- The intended licence is CC-BY-4.0.
- Sọ̀rọ̀ itself never stores audio, and that doesn't change.

[scripts/eval_asr.py](engine/scripts/eval_asr.py) already measures ASR word error rate, and the eval tooling grows from it.

## 5. Self-hosting

**Planned:**
- One `docker compose` profile with the engine, the gateway and plain Postgres on one machine with a 16 GB GPU. Today's models already fit on a T4.
- Supabase becomes optional.
- A CPU / Apple Silicon profile.
- The cloud setups (AWS, Modal, Render) become optional deploy guides.
- Each profile's running cost is documented.

## 6. Channels

**Planned.** WhatsApp becomes one channel adapter among several, and at least one channel doesn't depend on Meta, such as a web voice recorder or Telegram. A phone-call (IVR) channel for feature phones is a stretch goal.

## 7. Privacy defaults

**Planned.** What Sọ̀rọ̀ does today becomes the toolkit's default, written up on one page a community leader can read:
- no stored audio;
- hashed phone numbers;
- consent before anything is stored;
- `DELETE` anonymises the user;
- reminders encrypted and deleted within 23 hours;
- no third-party AI API.

## Model licences

The toolkit's code licence doesn't cover model weights. Each model keeps its own licence.

| Model | Used for | Licence |
|---|---|---|
| N-ATLaS | LLM (default profile) | N-ATLaS licence: free use capped at 1,000 active users per 30 days |
| NCAIR ASR (English, Yorùbá, Hausa, Igbo) | Speech recognition | NCAIR/Awarri research and innovation licence |
| Qwen3-8B | LLM (`qwen3-8b` profile) | Apache-2.0 |
| OmniVoice, Sam4rano/omnivoice-yoruba-tts | Speech | Apache-2.0 |
