# Router on two models

The router turns a message into an intent and its fields (amount, item, person and so on). It runs on any model behind `ChatModel` in [llm.py](../engine/soro_engine/llm.py). This page compares the two profiles in `LLM_PROFILES`:

- `n-atlas`: N-ATLaS, the default;
- `qwen3-8b`: Qwen3-8B (Apache-2.0), [Qwen/Qwen3-8B-GGUF](https://huggingface.co/Qwen/Qwen3-8B-GGUF) Q4_K_M.

## Method

[scripts/eval_router.py](../engine/scripts/eval_router.py) routes each of the 57 labelled few-shot examples in [prompts.py](../engine/soro_engine/prompts.py) with that example taken out of the prompt (leave-one-out), so the model never sees the answer. Both models get the same prompt, the same JSON schema (enforced by llama.cpp's grammar) and the same post-processing as production: tidying, the category call, and the amount parser that checks the model's amount against the words in the message.

- **Final amount**: the amount after the amount parser, which is what Sọ̀rọ̀ saves.
- **Model alone**: the amount the model wrote, before the parser.
- **Every labelled field**: intent and every labelled field match exactly.

Both ran on one NVIDIA T4 (llama.cpp, Q4_K_M, temperature 0.1) through [scripts/eval_router_modal.py](../engine/scripts/eval_router_modal.py).

## Results

| | n-atlas | qwen3-8b |
|---|---|---|
| Valid JSON in the schema | 57/57 | 57/57 |
| Intent | 47/57 (82%) | 44/57 (77%) |
| Amount, final | 41/41 (100%) | 39/41 (95%) |
| Amount, model alone | 29/41 (71%) | 21/41 (51%) |
| Every labelled field | 28/57 (49%) | 23/57 (40%) |
| Median seconds per message | 3.6 | 4.1 |

Intent by language:

| Language | Examples | n-atlas | qwen3-8b |
|---|---|---|---|
| English | 36 | 28 (78%) | 33 (92%) |
| Yorùbá | 13 | 12 (92%) | 8 (62%) |
| Hausa | 5 | 4 (80%) | 1 (20%) |
| Igbo | 3 | 3 (100%) | 2 (67%) |

The two models chose the same intent for 41 of the 57 examples.

## What this shows

- **Both models work behind the same interface.** Every answer was valid JSON in the schema, with no change to the prompt.
- **Qwen3-8B is better in English; N-ATLaS is much better in Yorùbá, Hausa and Igbo.** For Sọ̀rọ̀'s users N-ATLaS stays the default.
- **The amount parser carries amounts on both models.** Most of the models' amount misses are omissions, mainly on debts and transfers (N-ATLaS 9 of 12, Qwen3 17 of 20), and the parser reads those amounts from the message.
- **The most common intent error on both is `log_income`** chosen for a sale, an expense or a debt.

## Limits

- 57 examples, most in English, and only 5 in Hausa and 3 in Igbo. They are the router's own few-shot examples, written by the project, not real user messages. Treat the per-language numbers as a direction, not a measurement.
- Text only: no speech recognition in the loop.
- One quantisation (Q4_K_M) and one run per model.

The open evaluation set in [ROADMAP.md](../ROADMAP.md) is meant to replace this set with recorded, consented speech.

## Run it

```bash
cd engine
uv run --no-project --with modal modal run scripts/eval_router_modal.py   # both profiles on a Modal T4
uv run --extra ml python scripts/eval_router.py --profile qwen3-8b        # one profile, GGUF in engine/models
```
