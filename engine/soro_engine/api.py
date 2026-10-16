"""HTTP API used by the gateway. Every route except /health needs `Authorization: Bearer <ENGINE_TOKEN>`."""

from __future__ import annotations

import hmac
import time

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from .config import Lang
from .engine import SoroEngine


class RouteIn(BaseModel):
    text: str = Field(max_length=2000)
    lang: Lang
    today: str
    en_text: str | None = Field(default=None, max_length=2000)  # from /transcribe, when it sends one


class AdaptIn(BaseModel):
    tip: str = Field(max_length=1000)
    question: str = Field(max_length=1000)
    lang: Lang


class TranslateIn(BaseModel):
    text: str = Field(max_length=2000)
    target: Lang


class SpeakIn(BaseModel):
    text: str = Field(max_length=1200)
    lang: Lang


MAX_AUDIO_BYTES = 16 * 1024 * 1024  # WhatsApp's own audio limit


def create_api(engine: SoroEngine, token: str, clock=time.monotonic) -> FastAPI:
    if len(token) < 16:
        raise ValueError("ENGINE_TOKEN must be at least 16 characters")
    app = FastAPI(title="SoroEngine engine", docs_url=None, redoc_url=None)
    # When the gateway last used the engine (not /health, which anyone can call). On AWS the server stops itself
    # once this is old enough (aws/idle-stop.sh). Counted from startup, so a server woken for nothing sleeps again.
    last_used = [clock()]

    def auth(authorization: str = Header(default="")) -> None:
        if not hmac.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(status_code=401, detail="unauthorized")
        last_used[0] = clock()

    @app.middleware("http")
    async def timing(request: Request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        response.headers["x-elapsed-ms"] = str(int((time.perf_counter() - start) * 1000))
        return response

    @app.get("/health")
    def health() -> dict:
        return {"ok": True, "idle_s": int(clock() - last_used[0]), **engine.status()}

    @app.post("/transcribe", dependencies=[Depends(auth)])
    async def transcribe(request: Request, lang: Lang = Query("en"), detect: bool = Query(False)) -> dict:
        data = await request.body()
        if not data or len(data) > MAX_AUDIO_BYTES:
            raise HTTPException(status_code=400, detail="audio body missing or too large")
        try:
            return await run_in_threadpool(engine.transcribe, data, lang, detect)
        except ValueError as e:  # undecodable audio
            raise HTTPException(status_code=422, detail=str(e)) from e

    @app.post("/route", dependencies=[Depends(auth)])
    async def route(body: RouteIn) -> dict:
        return {"intent": await run_in_threadpool(engine.route, body.text, body.lang, body.today, body.en_text)}

    @app.post("/adapt", dependencies=[Depends(auth)])
    async def adapt(body: AdaptIn) -> dict:
        return {"text": await run_in_threadpool(engine.adapt, body.tip, body.question, body.lang)}

    @app.post("/translate", dependencies=[Depends(auth)])
    async def translate(body: TranslateIn) -> dict:
        return {"text": await run_in_threadpool(engine.translate, body.text, body.target)}

    @app.post("/speak", dependencies=[Depends(auth)])
    async def speak(body: SpeakIn) -> Response:
        ogg = await run_in_threadpool(engine.speak, body.text, body.lang)
        return Response(content=ogg, media_type="audio/ogg")

    return app
