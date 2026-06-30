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
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from server import config, llm
from server.schemas import ChatRequest, ChatResponse
from server.recipes import get_recipe_for_url
from server.agent.file_graph_store import FileGraphStore
from server.agent.file_memory import FileMemory
from server.agent.mock_brain import MockBrain
from server.agent.schemas import FillPlan, FormContext, MapRequest, PlanRequest, RememberRequest

app = FastAPI(title="Universal Data Chatbot (v0.2)")

# v0.4 두뇌(mock) + 그래프(파일) + 메모리(파일). 포트 뒤의 어댑터 — 나중에 LangGraph·실 그래프DB·Mem0 로 교체.
_brain = MockBrain()
_graph = FileGraphStore("server/data/site-graph.seed.json")
_memory = FileMemory("server/data/memory.json")


@app.middleware("http")
async def no_cache(request, call_next):
    # 챗봇 UI/정적 자산은 서버 배포로 갱신되므로 항상 최신을 받도록 캐시 금지(개발 편의).
    # 프로덕션에선 캐시 허용(자산은 ?v= 쿼리로 캐시버스팅) → DEV_MODE 일 때만 적용.
    resp = await call_next(request)
    if config.settings.dev_mode:
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.get("/api/config")
def app_config() -> JSONResponse:
    """챗 UI 가 개발 전용 기능(어떻게 답했나·추출 영역) 표시 여부를 알기 위한 플래그.

    이 플래그는 절대 캐시하면 안 된다 — dev_mode 를 켜도 옛 응답(off)이 캐시돼 막히는 함정 방지.
    """
    return JSONResponse({"devMode": config.settings.dev_mode}, headers={"Cache-Control": "no-store"})


@app.post("/api/chat", response_model=ChatResponse)
def chat(req: ChatRequest) -> ChatResponse:
    # v0.2 비스트리밍(폴백). 현재 UI 는 /api/chat/stream 을 사용한다.
    r = llm.answer_question(req.question, req.screen_context, req.history)
    return ChatResponse(answer=r["answer"], trace=r["trace"])


@app.post("/api/chat/stream")
def chat_stream(req: ChatRequest) -> StreamingResponse:
    """v0.3 PoC: 툴-콜링 + 스트리밍. SSE 로 tool_start/token/final/error 이벤트를 흘려보낸다.
    이벤트 규약은 docs/architecture/v0.3-direction.md §6.
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


@app.post("/api/agent/plan", response_model=FillPlan)
def agent_plan(req: PlanRequest) -> FillPlan:
    """v0.4 행동 에이전트 — 의도 + 현재 폼(FormContext) → 검사 가능한 fill-plan.

    intent 또는 intent_text 중 하나를 받고, form_context 가 없으면 그래프에서 폼스키마로 보완한다.
    실제 두뇌(LangGraph)로 교체해도 이 규약(FillPlan)은 그대로다.
    """
    intent = req.intent or _brain.parse_intent(req.intent_text or "")
    form = req.form_context
    if form is None:
        screen_id = req.screen_id or "pr-form"
        schema = _graph.get_form_schema(screen_id)
        if schema:
            from server.agent.schemas import ButtonSpec
            form = FormContext(
                screen_id=screen_id,
                fields=schema.fields,
                line_grid=schema.line_grid,
                save_button=ButtonSpec(key="#save-btn", label="저장"),
            )
        else:
            form = FormContext(screen_id=screen_id)
    return _brain.plan(intent, form, _graph, _memory)


@app.post("/api/agent/memory")
def agent_remember(req: RememberRequest) -> dict:
    """해소결과 적재 — "볼펜"→정식코드. 다음 계획에서 자동 사용돼 후보 고르기(HITL)가 준다."""
    _memory.remember(req.item, req.code)
    return {"ok": True, "item": req.item, "code": req.code}


# 변이 버튼(저장·삭제·제출·확인) — 매핑 모드가 *절대 엣지로 기록하지 않는* denylist(§8 가드레일).
_MUTATE_MARKERS = ("#save-btn", "row-delete", "#confirm-ok", "save", "delete", "submit")


def _is_mutate_target(target: str | None) -> bool:
    t = (target or "").lower()
    return any(m in t for m in _MUTATE_MARKERS)


@app.post("/api/agent/map")
def agent_map(req: MapRequest) -> dict:
    """매핑 모드 — 읽기전용 순회로 모은 화면·이동·폼스키마를 그래프에 적재(§8 능동 부트스트랩).

    변이 버튼은 엣지로 기록하지 않는다(denylist). 결과는 live 그래프 파일로 영속(시드는 보존).
    """
    added_nodes = added_edges = skipped = 0
    for obs in req.observations:
        if not obs.id:
            continue
        node: dict = {
            "id": obs.id,
            "kind": "form" if (obs.form_context and obs.form_context.fields) else "screen",
            "title": obs.title,
            "signature": obs.signature,
        }
        if obs.form_context and (obs.form_context.fields or obs.form_context.line_grid):
            node["formSchema"] = {
                "screen_id": obs.id,
                "fields": [f.model_dump() for f in obs.form_context.fields],
                "line_grid": obs.form_context.line_grid.model_dump() if obs.form_context.line_grid else None,
            }
        _graph.upsert_node(node)
        added_nodes += 1
        if obs.from_id and obs.via_target:
            if _is_mutate_target(obs.via_target):
                skipped += 1  # 변이 버튼은 기록 금지(가드레일)
            else:
                _graph.upsert_edge({"from": obs.from_id, "to": obs.id,
                                    "actions": [{"op": "click", "target": obs.via_target, "label": "매핑"}]})
                added_edges += 1
    _graph.save("server/data/site-graph.live.json")
    return {"ok": True, "nodes": added_nodes, "edges": added_edges,
            "skippedMutateEdges": skipped, "totalNodes": len(_graph.nodes)}


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


# v0.4 PoC 목업(구매시스템) — /mock/ = 단일 페이지. html=True 라 상대경로(app.js/style.css)가 그대로 풀린다.
# "레거시 업무화면" 역할로, 익스텐션·에이전트가 조작하는 대상이다(server/web/mock/).
app.mount("/mock", StaticFiles(directory="server/web/mock", html=True), name="mock")

# 챗봇 UI 정적 자산 (/static/chat/chat.js 등)
app.mount("/static", StaticFiles(directory="server/web"), name="static")

# 비주얼 문서(슬라이드 데크) — /slides/ = 목차, /slides/<deck>.html = 각 데크.
# 데크 추가 = slides/ 에 파일 + decks.json 항목만(서버 코드 변경 불필요).
app.mount("/slides", StaticFiles(directory="slides", html=True), name="slides")
