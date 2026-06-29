"""OpenAI 연동 + 프롬프트 (단순 1패스).

전제: 실제 화면은 라벨이 DOM 에 있으므로 어댑터가 데이터+라벨을 매핑해 ScreenContext 로 준다.
따라서 LLM 은 추론 없이 주어진 tables/sections/charts 로만 답한다.
"""

from __future__ import annotations

import json
import time
import traceback
from datetime import date

from openai import OpenAI

from server import config
from server.schemas import ScreenContext

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        api_key = config.settings.openai_api_key
        if not api_key:
            raise RuntimeError("OPENAI_API_KEY 가 설정되지 않았습니다. .env 를 확인하세요.")
        _client = OpenAI(api_key=api_key)
    return _client


SYSTEM_PROMPT = """당신은 사용자가 보는 웹 화면 데이터를 근거로 답하는 어시스턴트입니다.
화면 데이터(screen_context)는 익스텐션이 추출한 것입니다.
- tables : 표(여러 개). columns(label/unit/type) + rows.
- sections : 표가 아닌 블록. kind=card/keyvalue 는 fields(label/value), kind=text 는 text(구조화되지 않은 화면의 보이는 텍스트 폴백)에 내용이 있습니다.
- charts : 차트 원본(labels/series).
- source : 추출 방식(table/domStructure/dataLayer/recipe/text 등).

규칙:
- 반드시 위 tables/sections/charts 안의 정보만 근거로 답하세요. 추측하거나 외부 지식을 끌어오지 마세요.
- 관련 데이터가 전혀 없을 때만 "현재 화면 데이터에는 해당 정보가 없습니다."라고 답하세요.
- 숫자를 인용할 때 컬럼의 unit(단위)을 함께 표기하세요.
- 드물게 컬럼 label 이 null 이면 그 컬럼 의미를 단정하지 말고, 확신 가능한 범위에서만 답하세요.
- '최근/지난 N개월' 같은 상대적 기간은 오늘({today}) 기준으로 해석하세요.
- 한국어로 간결·정확하게. 표·목록 등 마크다운을 적극 활용하세요.
- 사용자가 그래프/차트/바·라인 등 '시각화'를 요청하면, 표로만 쓰지 말고 아래 코드블록으로 내보내세요
  (앱이 실제 차트로 렌더링). 같은 데이터를 표로 중복 출력하지 마세요.
  ```chart
  {{"type":"bar","title":"공종별","labels":["주택","토목"],"series":[{{"name":"계약금액","type":"bar","data":[912000,975000]}},{{"name":"현장수","type":"line","axis":"y1","data":[12,13]}}]}}
  ```
  - 각 series 에 "type"("bar"/"line")을 줄 수 있어 **한 차트에 바와 라인을 섞을 수 있습니다**(혼합 차트).
  - 한 차트의 모든 series 는 **같은 labels(x축)** 를 공유해야 합니다. 값 범위가 크게 다르면 보조축 "axis":"y1" 사용.
  - x축이 서로 다른 데이터(예: 공종별 vs 월별)는 **한 차트로 합치지 말고 차트 2개**(코드블록 2개)로 그리세요.
  - 차트에 대한 짧은 설명만 일반 텍스트로 덧붙이세요."""


# ── v0.3 PoC: 툴-콜링(스트리밍) ────────────────────────────────────────────
# "가짜 두뇌": 미래 AI 서비스(LangGraph 멀티에이전트)를 임시 연출. 라우팅을 우리가 짜지 않고
# LLM function-calling(네이티브 툴 선택)에 맡긴다 = 라우팅. (docs/architecture/v0.3-direction.md)
#
# 네이티브 툴은 OpenAI Responses API 의 호스티드 툴이라 OpenAI 가 실행까지 한다(우리는 켜고 관찰).
#  - web_search        : 화면 밖 실시간 정보(시세·뉴스·환율 등) + 출처 URL
#  - code_interpreter  : 화면 데이터로 정확 집계/정렬/통계/추세(생성형 집계오류 보완)
# 화면 데이터(screen_data)는 호출형 툴이 아니라 프롬프트에 항상 주입 → "툴 안 부르고 답함" = 화면만 사용.
#
# 주의: 네이티브 툴 타입명/모델 지원은 OpenAI API 변동이 잦다. web_search 가 거부되면
#       "web_search_preview" 로, 모델은 툴 지원 모델(gpt-4o 계열 등)로 .env OPENAI_MODEL 설정.
def _build_tools() -> list[dict]:
    """설정(enable_web_search·enable_code_interpreter)에 따라 켤 네이티브 툴 목록을 만든다."""
    tools: list[dict] = []
    if config.settings.enable_web_search:
        tools.append({"type": "web_search"})
    if config.settings.enable_code_interpreter:
        tools.append({"type": "code_interpreter", "container": {"type": "auto"}})
    return tools

TOOL_SYSTEM_PROMPT = """당신은 사용자가 보는 웹 화면 데이터를 근거로 답하는 어시스턴트입니다. 아래 도구를 쓸 수 있습니다.

[화면 데이터(screen_context)] — 익스텐션이 현재 화면에서 추출해 아래 [현재 화면 데이터]로 제공합니다.
- tables : 표(여러 개). columns(label/unit/type) + rows.
- sections : 표가 아닌 블록. card/keyvalue 는 fields(label/value), text 는 보이는 텍스트 폴백.
- charts : 차트 원본(labels/series). source : 추출 방식.

[도구 사용 규칙 — 라우팅]
- 화면 데이터만으로 답할 수 있으면 도구를 호출하지 말고 바로 답하세요(가장 흔한 경우).
- **여러 행에 걸친 수치 계산(합계·평균·최대/최소·정렬·표준편차·파생비율 등)은 답변 본문에서 직접 더하거나
  추정하지 말고, 반드시 code_interpreter 로 Python 을 실행해 계산하세요.** 데이터는 [현재 화면 데이터] JSON 을
  그대로 코드에 넣어 사용합니다. 본문에 숫자를 나열해 손으로 합산하는 것은 금지(직접 계산한 합계·평균은 자주 틀립니다).
  단, 화면에 이미 있는 값 1~2개를 그대로 읽어 답하는 경우는 도구 없이 답해도 됩니다.
- 외부/실시간 정보(화면·내부에 없는, 시간에 따라 변하는 값 — 오늘·현재의 환율·자재 시세·주가·뉴스 등)는
  **당신의 학습 지식으로 추정하지 말고 반드시 web_search 로 조회**하세요. 특히 '오늘/현재 환율·시세'는
  web_search 없이 답하지 마세요(머릿속 환율·시세 사용 금지). 결과의 출처 URL 을 함께 제시하세요.
- 복합 질문이면 여러 도구를 함께 쓰세요. 예: "1위 현장 금액을 오늘 환율로 USD 환산" →
  code_interpreter 로 1위 금액을 구하고, web_search 로 오늘 환율을 조회해 환산(추정 환율 금지).

[답변 규칙]
- 반드시 화면 데이터 또는 도구 결과에 근거하세요. 둘 다 없으면 "현재 화면 데이터에는 해당 정보가 없습니다."
- 한국어로 간결·정확하게. 숫자는 컬럼 unit(단위)과 함께 표기. 표·목록 등 마크다운 적극 활용.
- 컬럼 label 이 null 이면 의미를 단정하지 마세요. '최근/지난 N개월' 등 상대 기간은 오늘({today}) 기준.
- 사용자가 그래프/차트 등 '시각화'를 요청하면, 표로만 쓰지 말고 아래 코드블록으로 내보내세요(앱이 실제 차트로 렌더).
  같은 데이터를 표로 중복 출력하지 마세요.
  ```chart
  {{"type":"bar","title":"공종별","labels":["주택","토목"],"series":[{{"name":"계약금액","type":"bar","data":[912000,975000]}},{{"name":"현장수","type":"line","axis":"y1","data":[12,13]}}]}}
  ```
  - series 별 "type"("bar"/"line")로 혼합 차트 가능. 한 차트의 series 는 같은 labels(x축) 공유, 값 범위 크게 다르면 "axis":"y1".
  - x축이 다른 데이터는 한 차트로 합치지 말고 차트 2개로."""


def _build_messages(question: str, screen_context: ScreenContext, history: list | None) -> tuple[str, list]:
    """system 프롬프트와 input 메시지 목록을 만든다(스트리밍·비스트리밍 공용 형태)."""
    system = TOOL_SYSTEM_PROMPT.format(today=date.today().isoformat())
    data_json = json.dumps(screen_context.model_dump(), ensure_ascii=False)
    user = f"[현재 화면 데이터]\n{data_json}\n\n[질문]\n{question}"
    items: list = []
    for m in (history or [])[-config.settings.history_turns:]:  # 최근 history_turns 개
        role, content = m.get("role"), m.get("content")
        if role in ("user", "assistant") and content:
            items.append({"role": role, "content": str(content)})
    items.append({"role": "user", "content": user})
    return system, items


def _extract_citations(final) -> list[dict]:
    """Responses 최종 응답의 output_text annotation 에서 url_citation 을 모은다(중복 url 제거)."""
    out: list[dict] = []
    seen: set[str] = set()
    for item in getattr(final, "output", None) or []:
        for part in getattr(item, "content", None) or []:
            for ann in getattr(part, "annotations", None) or []:
                if getattr(ann, "type", None) == "url_citation":
                    url = getattr(ann, "url", None)
                    if url and url not in seen:
                        seen.add(url)
                        out.append({"url": url, "title": getattr(ann, "title", None) or url})
    return out


def stream_answer(question: str, screen_context: ScreenContext, history: list | None = None):
    """이벤트 제너레이터. v0.3 이음매 계약(docs/architecture/v0.3-direction.md §6)과 동일한 모양:
      {"type":"tool_start","tool":...} | {"type":"token","text":...}
      {"type":"final","tools_used":[...],"citations":[...],"trace":{...}} | {"type":"error","message":...}
    """
    system, items = _build_messages(question, screen_context, history)
    model = config.settings.openai_model
    user_payload = items[-1]["content"]
    has_screen = bool(screen_context.tables or screen_context.sections or screen_context.charts)

    fired: list[str] = []   # 실제 호출된 호스티드 툴(기계적 추적 → 출처 배지)
    seen_tool: set[str] = set()
    t0 = time.perf_counter()
    final = None
    MAX_RETRIES = config.settings.max_retries
    for attempt in range(MAX_RETRIES + 1):
        fired.clear()
        seen_tool.clear()
        yielded = False  # 토큰/툴 이벤트를 하나라도 내보냈나(보냈으면 재시도 못 함)
        try:
            client = _get_client()
            with client.responses.stream(
                model=model,
                instructions=system,
                input=items,
                tools=_build_tools(),
                temperature=config.settings.openai_temperature,
            ) as stream:
                for event in stream:
                    et = getattr(event, "type", "") or ""
                    if et == "response.output_text.delta":
                        yielded = True
                        yield {"type": "token", "text": getattr(event, "delta", "") or ""}
                        continue
                    tool = None
                    if "web_search" in et:
                        tool = "web_search"
                    elif "code_interpreter" in et:
                        tool = "code_interpreter"
                    if tool and tool not in seen_tool:
                        seen_tool.add(tool)
                        fired.append(tool)
                        yielded = True
                        yield {"type": "tool_start", "tool": tool}
                final = stream.get_final_response()
            break  # 성공
        except Exception as e:  # noqa: BLE001 — PoC: 어떤 실패든 처리
            status = getattr(e, "status_code", None)
            # 일시적 서버 오류(5xx)는 아직 아무것도 안 보냈을 때만 재시도(이미 토큰을 보냈으면 못 무름).
            if (not yielded) and attempt < MAX_RETRIES and isinstance(status, int) and status >= 500:
                time.sleep(0.5 * (attempt + 1))
                continue
            print(f"[llm] stream error: {type(e).__name__}: {e} (status={status})")  # 서버 로그(항상)
            if config.settings.dev_mode:
                traceback.print_exc()
                detail = f"{type(e).__name__}: {e}"
                extra = {k: v for k, v in {
                    "status": status, "request_id": getattr(e, "request_id", None),
                    "code": getattr(e, "code", None), "body": getattr(e, "body", None),
                }.items() if v}
                if extra:
                    detail += " | " + " ".join(f"{k}={v}" for k, v in extra.items())
                yield {"type": "error", "message": detail}
            else:
                yield {"type": "error", "message": "AI 응답 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."}
            return

    citations = _extract_citations(final)
    u = getattr(final, "usage", None)
    usage = (
        {
            "prompt_tokens": getattr(u, "input_tokens", None),
            "completion_tokens": getattr(u, "output_tokens", None),
            "total_tokens": getattr(u, "total_tokens", None),
        }
        if u else None
    )
    # 출처 배지(screen_data)는 '화면이 실제 답의 근거였을 때'만 표시(기계적 휴리스틱, 모델 자가신고 X):
    #  - code_interpreter 는 화면 데이터를 계산하므로 화면이 근거 → 포함
    #  - web_search 만 단독으로 쓴 답은 외부 출처 → 화면 미포함(배지 변별력 유지)
    #  - 툴을 안 쓴 답은 화면 근거 → 포함
    screen_used = has_screen and ("code_interpreter" in fired or "web_search" not in fired)
    tools_used = (["screen_data"] if screen_used else []) + fired
    final_event = {"type": "final", "tools_used": tools_used, "citations": citations}
    # trace(전체 프롬프트·페이로드)는 디버깅용 → DEV_MODE 일 때만 노출(프로덕션엔 안 보냄).
    if config.settings.dev_mode:
        final_event["trace"] = {
            "model": model,
            "latencyMs": int((time.perf_counter() - t0) * 1000),
            "payloadChars": len(user_payload),
            "usage": usage,
            "system": system,
            "user": user_payload,
            # 보낸 멀티턴 이력(현재 질문 제외). 길면 잘라 표기 — 답변-질문 불일치 디버깅용.
            "history": [
                {"role": m["role"], "content": (m["content"][:500] + "…") if len(m["content"]) > 500 else m["content"]}
                for m in items[:-1]
            ],
        }
    yield final_event


def answer_question(question: str, screen_context: ScreenContext, history: list | None = None) -> dict:
    """반환 {answer, trace}. trace = 모델/토큰/지연/보낸 페이로드(추적용).

    history(이전 Q&A 텍스트)를 system 뒤·현재 질문 앞에 끼워 멀티턴 맥락을 준다.
    화면 데이터는 '현재' 것만(이전 턴엔 안 실음) → 토큰 절약.
    """
    client = _get_client()
    model = config.settings.openai_model
    system = SYSTEM_PROMPT.format(today=date.today().isoformat())
    data_json = json.dumps(screen_context.model_dump(), ensure_ascii=False, indent=2)
    user = f"[현재 화면 데이터]\n{data_json}\n\n[질문]\n{question}"

    messages = [{"role": "system", "content": system}]
    for m in (history or [])[-config.settings.history_turns:]:  # 최근 history_turns 개
        role, content = m.get("role"), m.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)})
    messages.append({"role": "user", "content": user})

    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=model,
        temperature=config.settings.openai_temperature,
        messages=messages,
    )
    latency_ms = int((time.perf_counter() - t0) * 1000)
    answer = resp.choices[0].message.content or ""
    u = getattr(resp, "usage", None)
    trace = {
        "model": model,
        "systemChars": len(system),
        "payloadChars": len(user),
        "historyTurns": len(messages) - 2,  # system·현재질문 제외
        "latencyMs": latency_ms,
        "usage": (
            {"prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens, "total_tokens": u.total_tokens}
            if u else None
        ),
        "system": system,   # 페이로드 전체 보기용
        "user": user,
    }
    return {"answer": answer, "trace": trace if config.settings.dev_mode else None}
