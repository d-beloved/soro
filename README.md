# SoroEngine

A voice-first WhatsApp assistant for Nigerian informal traders, by Charavol Technologies Ltd.

Traders send a voice note or text in English, Pidgin, Yoruba, Hausa or Igbo. SoroEngine keeps their shop book (sales, expenses, debts, stock, summaries, loan requests) and shares short money tips, as text and as a voice reply.

Built for the NITDA / NCAIR **National AI Champions (NAIC) 2026**, Voice-First track. The plan is in [PLAN.md](PLAN.md).

## How it fits together

```
WhatsApp user
   │  voice note / text
   ▼
Meta WhatsApp Cloud API ──webhook──▶ gateway/  (Node 22 + Hono, on Railway)
                                      │  consent, routing, commerce, tutor, replies
                                      ├──▶ Supabase Postgres (EU)        supabase/
                                      └──▶ engine/  (FastAPI on Modal, T4 GPU)
                                             • ASR: NCAIR Nigerian-accented English, Yoruba, Hausa, Igbo (Whisper-small)
                                             • LLM: N-ATLaS (Llama-3 8B) as GGUF Q4_K_M via llama.cpp: intent routing, tip adaptation, translation
                                             • TTS: YarnGPT2 → Opus voice note
Landing page, privacy, terms ─────── site/  (static, Cloudflare Pages → soro.charavol.com)
```

- **Privacy:** phone numbers are stored only as a salted SHA-256 hash. Nothing happens before the user consents (NDPA 2023). Audio is never stored. `DELETE` erases a user. Inactive users are purged after 12 months.
- **Tips** come only from the curated library in `supabase/seed/tips.sql`. The LLM rephrases a tip; it does not invent advice.

## Repository

| Path | What |
|---|---|
| `gateway/` | WhatsApp webhook service. `src/pipeline/handle.ts` is the message flow. |
| `engine/` | GPU model service. `soro_engine/api.py` holds the endpoints and `modal_app.py` the deployment. |
| `supabase/migrations/` | Schema (`0001_init.sql`) and the retention purge (`0002_retention.sql`). |
| `supabase/seed/tips.sql` | The financial-literacy tip library. |
| `site/` | Landing page, privacy notice, terms, logo and the WhatsApp profile image. |
| `scripts/` | `set_whatsapp_number.py` (puts the number and QR into the site) and `serve_site.mjs` (local preview). |

## Local development

Requirements: Node 22, [uv](https://docs.astral.sh/uv/), ffmpeg (`brew install ffmpeg`).

### Gateway

```bash
cd gateway
npm install
cp .env.example .env      # fill it in
npm test                  # 43 tests
npm run typecheck
npm run dev               # http://localhost:3000
```

To receive real WhatsApp messages locally, expose port 3000 (for example `cloudflared tunnel --url http://localhost:3000`) and point the Meta webhook at `<tunnel>/webhook`.

### Engine

```bash
cd engine
uv sync                           # light deps, enough for tests
uv run pytest                     # 46 tests
```

To run the models locally (Apple Silicon Mac: ASR and LLM work; TTS is CPU-only and slow, so set `VOICE_REPLIES=off` in the gateway):

```bash
uv sync --extra ml
export HF_TOKEN=hf_xxx            # after accepting the model terms on Hugging Face
uv run --extra ml python -m soro_engine.setup_models            # about 30 GB of downloads; add --skip-llm to skip N-ATLaS
ENGINE_TOKEN=dev-token-change-me-123 uv run --extra ml python serve_local.py --no-tts
```

`setup_models` converts the official N-ATLaS weights to GGUF itself. If llama.cpp refuses the tokenizer, `--allow-community-gguf` falls back to the QuantFactory build.

### Site

```bash
node scripts/serve_site.mjs       # http://localhost:4321
```

## Deploy

1. **Supabase** (EU region): in the SQL editor run `supabase/migrations/0001_init.sql`, then `0002_retention.sql`, then `supabase/seed/tips.sql`.
2. **Engine on Modal:**
   ```bash
   cd engine
   uv run --with modal modal token new
   bash scripts/create_modal_secret.sh      # asks for HF_TOKEN, reuses ENGINE_TOKEN from gateway/.env
   uv run --with modal modal run modal_app.py::setup_models
   uv run --with modal modal deploy modal_app.py
   ```
   The deploy prints the engine URL. Containers scale to zero. During Oct 7–11 a cron keeps one warm from 09:00 to 21:00 WAT. Use `modal run modal_app.py::warm --on` or `--no-on` to override.
3. **Gateway on Railway:** create a new project from the GitHub repo, set the root directory to `gateway`, and add every variable from `.env.example`. `railway.json` sets the build, the start command and the `/health` check.
4. **Meta webhook:** set the callback URL to `https://<railway-domain>/webhook`, use the same verify token as `WA_VERIFY_TOKEN`, and subscribe to `messages`.
5. **Site on Cloudflare Pages:** no build command, output directory `site`, custom domain `soro.charavol.com`.

## Scripts

| Command | Does |
|---|---|
| `npm run export:csv` (gateway) | Writes the NAIC interaction log to `exports/naic_interactions_<date>.csv` |
| `uv run python scripts/translate_tips.py` (engine) | Drafts Yoruba/Hausa/Igbo tips into `supabase/seed/tip_translations.json` |
| `npm run tips:sync` (gateway) | Uploads those drafts to Supabase |
| `npm run locales:translate` (gateway) | Drafts missing `src/locales/{yo,ha,ig}.json` strings |
| `uv run --extra ml python scripts/eval_asr.py` (engine) | ASR word error rate from `engine/eval/<lang>/transcripts.csv` |
| `uv run --with qrcode python scripts/set_whatsapp_number.py 234…` | Puts the WhatsApp number and QR into the site |

All machine translations are drafts. A native speaker must review them before they are marked `reviewed`.

## Credits and licences

- **N-ATLaS** is an initiative of the Federal Ministry of Communications, Innovation and Digital Economy, and powered by Awarri Technologies. Its licence caps free use at 1,000 active users per 30 days.
- Speech recognition: NCAIR models on Hugging Face (`NCAIR1/NigerianAccentedEnglish`, `NCAIR1/Yoruba-ASR`, `NCAIR1/Hausa-ASR`, `NCAIR1/Igbo-ASR`).
- Text-to-speech: [YarnGPT2](https://huggingface.co/saheedniyi/YarnGPT2) with WavTokenizer.

© 2026 Charavol Technologies Ltd.
