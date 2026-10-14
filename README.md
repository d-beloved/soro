# Sọ̀rọ̀

A voice-first WhatsApp money assistant for Nigerians, with more of Africa coming soon, by Charavol Technologies Ltd. Sọ̀rọ̀ means "talk" in Yorùbá. SoroEngine is the code name of the back end (the engine and gateway in this repo, and their service URLs).

People send a voice note or text in English, Pidgin, Yoruba, Hausa or Igbo about what they spend, earn, sell or lend. Sọ̀rọ̀ keeps the record and tells them where their money went. A voice note gets a short spoken reply as well as the text:

- **Personal money** (workers, students): spending by category, money in, monthly budgets, money lent and repaid, summaries.
- **Small businesses** (traders, artisans, food sellers, riders): sales or paid work, business costs, stock counts, debts and repayments, loan requests.
- **Everyone:** money tips as text, fix the last amount ("no be 5k, na 50k") or type `UNDO`; `SHARE` sends a forwardable invite link that carries the user's own referral code.

## How it fits together

```
WhatsApp user
   │  voice note / text
   ▼
Meta WhatsApp Cloud API ──webhook──▶ gateway/  (Node 22 + Hono, on Render)
                                      │  consent, routing, commerce, tutor, replies
                                      ├──▶ Supabase Postgres (EU)        supabase/
                                      └──▶ engine/  (FastAPI on an AWS T4 GPU, Modal as fallback)
                                             • ASR: NCAIR Nigerian-accented English, Yoruba, Hausa, Igbo (Whisper-small)
                                             • LLM: N-ATLaS (Llama-3 8B) as GGUF Q4_K_M via llama.cpp: intent routing, tip adaptation, translation
                                             • TTS: OmniVoice (Yoruba fine-tune for Yoruba) → Opus voice note
Landing page, privacy, terms ─────── site/  (static, Cloudflare Pages → soro.charavol.com)
```

- **Privacy:** phone numbers are stored only as a salted SHA-256 hash. The one exception is a pending reminder, which keeps the number AES-256-GCM encrypted (key only in the gateway) for at most 23 hours. Nothing happens before the user consents (NDPA 2023). Audio is never stored. `DELETE` erases a user and everything they sent, as does the purge of users inactive for 12 months; each leaves only an unlinkable row per message (time, voice or text, language, intent) so usage counts survive.
- **Tips** come only from the curated library in `supabase/seed/tips.sql`. The LLM rephrases a tip; it does not invent advice.

## Repository

| Path                     | What                                                                                                                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateway/`               | WhatsApp webhook service. `src/pipeline/handle.ts` is the message flow.                                                                                                                                                                                   |
| `engine/`                | GPU model service. `soro_engine/api.py` holds the endpoints, `aws/` and `Dockerfile` the AWS deployment, `modal_app.py` the Modal one.                                                                                                                                                            |
| `supabase/migrations/`   | Schema (`0001_init.sql`), the retention purge (`0002_retention.sql`), personal money, budgets and undo (`0003_personal_money.sql`), the gateway's table privileges (`0004_service_role_grants.sql`), the export view names (`0005_rename_views.sql`), anonymise-on-delete (`0006_anonymise_on_delete.sql`), the reminder (`0007_nudge.sql`) and pending reminders (`0008_pending_nudges.sql`). |
| `supabase/seed/tips.sql` | The financial-literacy tip library.                                                                                                                                                                                                                       |
| `site/`                  | Landing page, privacy notice, terms, logo and the WhatsApp profile image.                                                                                                                                                                                 |
| `scripts/`               | `set_whatsapp_number.py` (puts the number and QR into the site) and `serve_site.mjs` (local preview).                                                                                                                                                     |

## Local development

Requirements: Node 22, [uv](https://docs.astral.sh/uv/), ffmpeg (`brew install ffmpeg`).

### Gateway

```bash
cd gateway
npm install
cp .env.example .env      # fill it in
npm test                  # 57 tests
npm run typecheck
npm run dev               # http://localhost:3000
```

To receive real WhatsApp messages locally, expose port 3000 (for example `cloudflared tunnel --url http://localhost:3000`) and point the Meta webhook at `<tunnel>/webhook`.

### Engine

```bash
cd engine
uv sync                           # light deps, enough for tests
uv run pytest                     # 48 tests
```

To run the models locally (on an Apple Silicon Mac, ASR and the LLM work; TTS is CPU-only and slow, so set `VOICE_REPLIES=off` in the gateway):

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

1. **Supabase** (EU region): in the SQL editor run `supabase/migrations/0001_init.sql`, then `0002_retention.sql`, then `0003_personal_money.sql`, then `0004_service_role_grants.sql`, then `0005_rename_views.sql`, then `0006_anonymise_on_delete.sql`, then `0007_nudge.sql`, then `0008_pending_nudges.sql`, then `supabase/seed/tips.sql`.
2. **Engine on Modal** (the fallback, and the whole engine if you skip AWS):
   ```bash
   cd engine
   uv run --with modal modal token new
   bash scripts/create_modal_secret.sh      # asks for HF_TOKEN, reuses ENGINE_TOKEN from gateway/.env
   uv run --with modal modal run modal_app.py::setup_models
   uv run --with modal modal deploy modal_app.py
   ```
   The deploy prints the engine URL. Containers scale to zero after 5 idle minutes, so the first message after a quiet spell waits for a cold start (about 45s). `modal run modal_app.py::warm --on` keeps one up until the next deploy, e.g. for a demo; `--no-on` lets it sleep again.
   **Engine on AWS** (main, always on): follow [engine/aws/README.md](engine/aws/README.md).
3. **Gateway on Render** (free web service): connect the GitHub repo, root directory `gateway`, build `npm ci && npm run build`, start `npm start`, health check path `/health`, region Frankfurt. Add every variable from `.env.example` (`ENGINE_URL` set to the AWS engine and `ENGINE_FALLBACK_URL` to the Modal URL, or `ENGINE_URL` to Modal alone; `NUDGE_KEY` from `openssl rand -base64 32`; and `NODE_VERSION=22`); leave `PORT` to Render. Free services sleep after 15 idle minutes, so point an uptime monitor at `/health` every 5 minutes.
4. **Meta webhook:** set the callback URL to `https://<your-gateway>/webhook`, use the same verify token as `WA_VERIFY_TOKEN`, and subscribe to `messages`.
5. **Site on Cloudflare Pages:** `npx wrangler pages deploy site --project-name <your-project> --branch main`.

## Scripts

| Command                                                           | Does                                                                     |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `npm run export:csv` (gateway)                                    | Writes the interaction log to `exports/interactions_<date>.csv`          |
| `npm run tips:sync` (gateway)                                     | Uploads `supabase/seed/tip_translations.json` to Supabase                |
| `uv run --extra ml python scripts/eval_asr.py` (engine)           | ASR word error rate from `engine/eval/<lang>/transcripts.csv`            |
| `uv run --with qrcode python scripts/set_whatsapp_number.py 234…` | Puts the WhatsApp number and QR into the site                            |

Yoruba, Hausa and Igbo strings and tips are hand-translated from the English. A native speaker must review them before they are marked `reviewed`.

## Credits and licences

- **N-ATLaS** is an initiative of the Federal Ministry of Communications, Innovation and Digital Economy, and powered by Awarri Technologies. Its licence caps free use at 1,000 active users per 30 days.
- Speech recognition: NCAIR models on Hugging Face (`NCAIR1/NigerianAccentedEnglish`, `NCAIR1/Yoruba-ASR`, `NCAIR1/Hausa-ASR`, `NCAIR1/Igbo-ASR`).
- Text-to-speech: [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice) (Apache-2.0), and for Yoruba its fine-tune [Sam4rano/omnivoice-yoruba-tts](https://huggingface.co/Sam4rano/omnivoice-yoruba-tts) (Apache-2.0).

© 2026 Charavol Technologies Ltd.
