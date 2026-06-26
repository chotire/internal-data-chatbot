"""FastAPI 진입점 (v0.2).

- GET /demo        : "레거시" 비즈니스 화면(일반 HTML 표). 익스텐션이 읽는 대상.
- GET /chat        : 챗봇 UI (익스텐션 Side Panel 의 iframe 으로 로드됨).
- POST /api/chat   : 익스텐션이 추출한 ScreenContext + 질문 -> LLM 응답.
- GET /static/*    : 챗봇 UI 정적 자산.

실행(루트에서): uv run uvicorn server.main:app --reload
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from server import llm
from server.schemas import ChatRequest, ChatResponse
from server.recipes import get_recipe_for_url

app = FastAPI(title="Universal Data Chatbot (v0.2)")


@app.middleware("http")
async def no_cache(request, call_next):
    # 챗봇 UI/정적 자산은 서버 배포로 갱신되므로 항상 최신을 받도록 캐시 금지(개발 편의).
    resp = await call_next(request)
    resp.headers["Cache-Control"] = "no-store"
    return resp


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    r = llm.answer_question(req.question, req.screen_context, req.history)
    return ChatResponse(answer=r["answer"], trace=r["trace"])


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
def slides() -> FileResponse:
    """아키텍처 브리핑 슬라이드(공유용)."""
    return FileResponse("slides.html")


# 챗봇 UI 정적 자산 (/static/chat/chat.js 등)
app.mount("/static", StaticFiles(directory="server/web"), name="static")
