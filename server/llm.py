"""OpenAI 연동 + 프롬프트 (단순 1패스).

전제: 실제 화면은 라벨이 DOM 에 있으므로 어댑터가 데이터+라벨을 매핑해 ScreenContext 로 준다.
따라서 LLM 은 추론 없이 주어진 tables/sections/charts 로만 답한다.
"""

from __future__ import annotations

import json
import os
import time
from datetime import date

from dotenv import load_dotenv
from openai import OpenAI

from server.schemas import ScreenContext

load_dotenv()

_client: OpenAI | None = None


def _get_client() -> OpenAI:
    global _client
    if _client is None:
        api_key = os.environ.get("OPENAI_API_KEY")
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


def answer_question(question: str, screen_context: ScreenContext, history: list | None = None) -> dict:
    """반환 {answer, trace}. trace = 모델/토큰/지연/보낸 페이로드(추적용).

    history(이전 Q&A 텍스트)를 system 뒤·현재 질문 앞에 끼워 멀티턴 맥락을 준다.
    화면 데이터는 '현재' 것만(이전 턴엔 안 실음) → 토큰 절약.
    """
    client = _get_client()
    model = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
    system = SYSTEM_PROMPT.format(today=date.today().isoformat())
    data_json = json.dumps(screen_context.model_dump(), ensure_ascii=False, indent=2)
    user = f"[현재 화면 데이터]\n{data_json}\n\n[질문]\n{question}"

    messages = [{"role": "system", "content": system}]
    for m in (history or [])[-8:]:  # 최근 4쌍만
        role, content = m.get("role"), m.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": str(content)})
    messages.append({"role": "user", "content": user})

    t0 = time.perf_counter()
    resp = client.chat.completions.create(
        model=model,
        temperature=0.2,
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
    return {"answer": answer, "trace": trace}
