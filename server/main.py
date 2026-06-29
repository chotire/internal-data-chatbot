"""FastAPI 진입점 (v0.2).

- GET /demo        : "레거시" 비즈니스 화면(일반 HTML 표). 익스텐션이 읽는 대상.
- GET /chat        : 챗봇 UI (익스텐션 Side Panel 의 iframe 으로 로드됨).
- POST /api/chat   : 익스텐션이 추출한 ScreenContext + 질문 -> LLM 응답.
- GET /static/*    : 챗봇 UI 정적 자산.

실행(루트에서): uv run uvicorn server.main:app --reload
"""

from __future__ import annotations

import json

from fastapi import FastAPI
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from server import config, llm
from server.schemas import ChatRequest, ChatResponse
from server.recipes import get_recipe_for_url

app = FastAPI(title="Universal Data Chatbot (v0.2)")


@app.middleware("http")
async def no_cache(request, call_next):
    # 챗봇 UI/정적 자산은 서버 배포로 갱신되므로 항상 최신을 받도록 캐시 금지(개발 편의).
    # 프로덕션에선 캐시 허용(자산은 ?v= 쿼리로 캐시버스팅) → DEV_MODE 일 때만 적용.
    resp = await call_next(request)
    if config.settings.dev_mode:
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/config")
def app_config() -> dict:
    """챗 UI 가 개발 전용 기능(어떻게 답했나·추출 영역) 표시 여부를 알기 위한 플래그."""
    return {"devMode": config.settings.dev_mode}


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    # v0.2 비스트리밍(폴백). 현재 UI 는 /api/chat/stream 을 사용한다.
    r = llm.answer_question(req.question, req.screen_context, req.history)
    return ChatResponse(answer=r["answer"], trace=r["trace"])


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    """v0.3 PoC: 툴-콜링 + 스트리밍. SSE 로 tool_start/token/final/error 이벤트를 흘려보낸다.
    이벤트 계약은 docs/architecture/v0.3-direction.md §6.
    """
    def gen():
        for ev in llm.stream_answer(req.question, req.screen_context, req.history):
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/recipe")
def recipe(url: str = "") -> dict:
    """현재 URL 에 맞는 추출 레시피를 반환. 없으면 recipe=null."""
    return {"recipe": get_recipe_for_url(url)}


@app.get("/")
@app.get("/demo")
def demo() -> FileResponse:
    return FileResponse("server/web/demo.html")


@app.get("/chat")
def chat_ui() -> FileResponse:
    return FileResponse("server/web/chat/index.html")


@app.get("/slides")
@app.get("/slides.html")
def slides_redirect() -> RedirectResponse:
    """레거시 경로 → 비주얼 문서 목차로."""
    return RedirectResponse("/slides/")


# 챗봇 UI 정적 자산 (/static/chat/chat.js 등)
app.mount("/static", StaticFiles(directory="server/web"), name="static")

# 비주얼 문서(슬라이드 데크) — /slides/ = 목차, /slides/<deck>.html = 각 데크.
# 데크 추가 = slides/ 에 파일 + decks.json 항목만(서버 코드 변경 불필요).
app.mount("/slides", StaticFiles(directory="slides", html=True), name="slides")
