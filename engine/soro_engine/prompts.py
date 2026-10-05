"""Prompts for N-ATLaS. Router output is constrained to ROUTER_SCHEMA by llama.cpp's JSON grammar.

The yo/ha/ig few-shot examples are first drafts: have a native speaker check them
(and swap in real phrasings from pilot voice notes) before the demo.
"""

from __future__ import annotations

import json

from .config import LANG_NAMES, Lang

INTENTS = [
    "log_sale", "log_expense", "log_debt", "stock_update", "summary_query",
    "loan_intake", "ask_question", "greeting", "help", "unknown",
]
TOPICS = ["separate_money", "record_keeping", "cash_flow", "debt_recovery", "credit_readiness", "savings", "pricing"]

_str = {"type": ["string", "null"]}
_num = {"type": ["number", "null"]}

ROUTER_SCHEMA = {
    "type": "object",
    "properties": {
        "intent": {"type": "string", "enum": INTENTS},
        "item": _str,
        "quantity": _num,
        "unit": _str,
        "amount_ngn": _num,
        "counterparty": _str,
        "direction": {"type": ["string", "null"], "enum": ["owed_to_me", "i_owe", None]},
        "period": {"type": ["string", "null"], "enum": ["today", "week", "month", None]},
        "topic": {"type": ["string", "null"], "enum": [*TOPICS, None]},
        "question": _str,
        "purpose": _str,
    },
    "required": ["intent"],
}

ROUTER_SYSTEM = """You are the message router for SoroEngine, a WhatsApp bookkeeping and money-tips assistant for Nigerian market traders.
Today is {today}. The trader speaks {lang_name}; the message may also mix English, Pidgin, Yoruba, Hausa or Igbo.
Messages are often voice-note transcripts, so expect missing punctuation and spelling mistakes.

Return ONE JSON object. Fields:
- intent:
  log_sale (trader sold something), log_expense (trader paid/bought for the business),
  log_debt (someone owes the trader, or the trader owes someone), stock_update (goods remaining / goods received),
  summary_query (asks how much they sold/spent/profit/debts), loan_intake (wants a loan or credit),
  ask_question (any question about money, saving, pricing, debt, records, loans), greeting, help, unknown.
- item, quantity, unit: the goods, e.g. item "rice", quantity 3, unit "bags".
- amount_ngn: total amount in naira as a plain number. Copy digits exactly: "10,000" = 10000, "5k" = 5000, "2.5m" = 2500000.
  Words: "five thousand" = 5000; Yoruba ẹgbẹ̀rún, Hausa dubu, Igbo puku = thousand, and the count comes after it
  ("ẹgbẹ̀rún márùn-ún" = 5000, "dubu biyar" = 5000, "puku iri ise" = 50000).
- counterparty: the other person in a debt, e.g. "Mama Chidi".
- direction (log_debt only): owed_to_me or i_owe.
- period (summary_query only): today, week or month.
- topic (ask_question only): one of separate_money, record_keeping, cash_flow, debt_recovery, credit_readiness, savings, pricing.
- question (ask_question only): the question, rewritten clearly in English.
- purpose (loan_intake only): what the loan is for, in English.
Use null for anything not said. Never invent amounts."""

FEW_SHOT: list[tuple[str, dict]] = [
    ("I sell three bags of rice seventy five thousand",
     {"intent": "log_sale", "item": "rice", "quantity": 3, "unit": "bags", "amount_ngn": 75000}),
    ("I don buy fuel for generator 4500",
     {"intent": "log_expense", "item": "generator fuel", "amount_ngn": 4500}),
    ("Mama Chidi owe me five thousand naira",
     {"intent": "log_debt", "counterparty": "Mama Chidi", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("I still owe Alhaji 20k for the goods wey I collect",
     {"intent": "log_debt", "counterparty": "Alhaji", "amount_ngn": 20000, "direction": "i_owe"}),
    ("I get ten carton of Indomie remain",
     {"intent": "stock_update", "item": "Indomie", "quantity": 10, "unit": "cartons"}),
    ("Iya Bisi still owe me 3k for pepper",
     {"intent": "log_debt", "counterparty": "Iya Bisi", "amount_ngn": 3000, "direction": "owed_to_me"}),
    ("How much I don sell this week",
     {"intent": "summary_query", "period": "week"}),
    ("I need loan of 200k to buy more goods",
     {"intent": "loan_intake", "amount_ngn": 200000, "purpose": "buy more goods"}),
    ("How I go take save money when market slow",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money when sales are slow?"}),
    # Yoruba (draft)
    ("Mo ta àpò ìrẹsì méjì ní 50,000 naira",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    ("Mo ta ata ní ẹgbẹ̀rún márùn-ún naira",
     {"intent": "log_sale", "item": "pepper", "amount_ngn": 5000}),
    # code-mixed: Yoruba/Hausa/Igbo sentence with English goods and digits
    ("mo ra rice agolo kan 10,000",
     {"intent": "log_expense", "item": "rice", "quantity": 1, "unit": "agolo", "amount_ngn": 10000}),
    ("Báwo ni mo ṣe lè fi owó pamọ́",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money?"}),
    # Hausa (draft)
    ("Na sayar da buhun shinkafa uku naira dubu saba'in da biyar",
     {"intent": "log_sale", "item": "rice", "quantity": 3, "unit": "bags", "amount_ngn": 75000}),
    ("Ina bin Musa bashin naira dubu biyar",
     {"intent": "log_debt", "counterparty": "Musa", "amount_ngn": 5000, "direction": "owed_to_me"}),
    ("Na sayar da rice bags biyu 50k",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    # Igbo (draft)
    ("Erere m akpa osikapa abụọ, puku naira iri ise",
     {"intent": "log_sale", "item": "rice", "quantity": 2, "unit": "bags", "amount_ngn": 50000}),
    ("Azụrụ m tomatoes basket otu 15,000",
     {"intent": "log_expense", "item": "tomatoes", "quantity": 1, "unit": "basket", "amount_ngn": 15000}),
    ("Kedụ ka m ga-esi chekwaa ego",
     {"intent": "ask_question", "topic": "savings", "question": "How can I save money?"}),
    ("Good morning o",
     {"intent": "greeting"}),
]


def route_messages(text: str, lang: Lang, today: str) -> list[dict]:
    messages = [{"role": "system", "content": ROUTER_SYSTEM.format(today=today, lang_name=LANG_NAMES[lang])}]
    for user, out in FEW_SHOT:
        messages.append({"role": "user", "content": user})
        messages.append({"role": "assistant", "content": json.dumps(out, ensure_ascii=False)})
    messages.append({"role": "user", "content": text})
    return messages


ADAPT_SYSTEM = """You are SoroEngine's money tutor for Nigerian market traders. Your answer will be read aloud as a WhatsApp voice note.
Answer the trader's question using ONLY the advice in the TIP below. Do not add new facts, numbers, products, banks, apps or investment advice.
Write in {lang_name}. Use at most 3 short sentences and simple everyday words. No lists, no emoji.

TIP: {tip}"""


def adapt_messages(tip: str, question: str, lang: Lang) -> list[dict]:
    return [
        {"role": "system", "content": ADAPT_SYSTEM.format(lang_name=LANG_NAMES[lang], tip=tip)},
        {"role": "user", "content": question},
    ]


TRANSLATE_SYSTEM = """Translate the user's text from English into {lang_name} for market traders in Nigeria.
Use simple, natural, everyday words, not formal or literary language.
Keep these exactly as they are: anything in curly braces like {{amount}}, emoji, line breaks, URLs, numbers, the words SoroEngine, N-ATLaS, HELP, LANGUAGE and DELETE.
Output only the translation."""


def translate_messages(text: str, target: Lang) -> list[dict]:
    return [
        {"role": "system", "content": TRANSLATE_SYSTEM.format(lang_name=LANG_NAMES[target])},
        {"role": "user", "content": text},
    ]
