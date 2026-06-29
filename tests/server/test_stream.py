"""서버측 v0.3 툴-콜링/스트리밍 검증 — OpenAI 없이 결정론적으로 가능한 부분만.

검증 범위(=실제 OpenAI 호출 없이 고정 가능한 로직):
  1) _build_messages : system 프롬프트 + input 메시지 형태(화면 데이터 주입·history 절단)
  2) _extract_citations : 최종 응답 annotation 에서 url_citation 추출·중복 url 제거
  3) stream_answer 이벤트 매핑 : fake Responses 스트림 주입 → token/tool_start/final 변환
     (가장 드리프트 위험 큰 부분 — 이벤트 타입명/툴 추적/usage·citations 매핑)
  4) /api/chat/stream SSE 프레이밍 : stub 한 stream_answer 이벤트가 "data: {json}\n\n" 로 흐르는지

OpenAI 에 실제로 붙는 부분(툴 라우팅 정확도, 실제 이벤트 타입명, 모델 지원)은 자동화 불가 → 수동.

실행: uv run python tests/server/test_stream.py   (종료코드 0=성공)
"""

from __future__ import annotations

import json
import pathlib
import sys
from types import SimpleNamespace

# 파일로 직접 실행해도 프로젝트 루트를 import 경로에 넣는다.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from server import config, llm
from server.schemas import ScreenContext

config.settings.dev_mode = True  # trace 노출은 DEV_MODE 일 때만 → 테스트는 켜고 검증

_checks: list[tuple[str, bool]] = []


def check(name: str, cond: bool) -> None:
    _checks.append((name, bool(cond)))


SC = ScreenContext(
    source="table",
    tables=[{"title": "t", "columns": [{"key": "c0", "label": "현장"}], "rows": [{"c0": "현장-01"}]}],
)


# 1) _build_messages ────────────────────────────────────────────────────────
system, items = llm._build_messages(
    "계약금액 최대 현장?",
    SC,
    history=[{"role": "user", "content": "이전질문"}, {"role": "assistant", "content": "이전답"}],
)
check("system 에 툴 라우팅 규칙 포함", "code_interpreter" in system and "web_search" in system)
check("input 마지막은 현재 질문(user)", items[-1]["role"] == "user")
check("현재 질문에 화면 데이터 JSON 주입", "현장-01" in items[-1]["content"] and "계약금액 최대 현장?" in items[-1]["content"])
check("history 가 현재 질문 앞에 옴", items[0]["content"] == "이전질문" and len(items) == 3)

# history 절단(최근 8개=4쌍)
long_hist = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"m{i}"} for i in range(20)]
_, items2 = llm._build_messages("q", SC, history=long_hist)
check("history 최근 8개로 절단(+현재질문=9)", len(items2) == 9)


# 2) _extract_citations ──────────────────────────────────────────────────────
def _ann(type_, url=None, title=None):
    return SimpleNamespace(type=type_, url=url, title=title)


fake_final_cite = SimpleNamespace(
    output=[
        SimpleNamespace(content=[
            SimpleNamespace(annotations=[
                _ann("url_citation", "https://a.com", "A"),
                _ann("url_citation", "https://a.com", "A-중복"),  # 같은 url → 제거
                _ann("other"),                                      # citation 아님 → 무시
                _ann("url_citation", "https://b.com", None),       # title 없음 → url 폴백
            ])
        ])
    ]
)
cites = llm._extract_citations(fake_final_cite)
check("citation 2건(중복 url 제거)", len(cites) == 2)
check("citation 첫 항목 url/title", cites[0] == {"url": "https://a.com", "title": "A"})
check("citation title 없으면 url 폴백", cites[1]["title"] == "https://b.com")
check("citation 없는 응답 → []", llm._extract_citations(SimpleNamespace(output=[])) == [])


# 3) stream_answer 이벤트 매핑 (fake Responses 스트림 주입) ────────────────────
class _FakeStream:
    def __init__(self, events, final):
        self._events, self._final = events, final

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def __iter__(self):
        return iter(self._events)

    def get_final_response(self):
        return self._final


def _ev(type_, **kw):
    return SimpleNamespace(type=type_, **kw)


fake_events = [
    _ev("response.output_text.delta", delta="안녕"),
    _ev("response.web_search_call.searching"),     # → tool_start web_search (최초 1회)
    _ev("response.web_search_call.completed"),      # → 같은 툴 중복 금지
    _ev("response.output_text.delta", delta=" 끝"),
    _ev("response.code_interpreter_call.in_progress"),  # → tool_start code_interpreter
    _ev("response.something.else"),                 # → 무시
]
fake_final = SimpleNamespace(
    output=[SimpleNamespace(content=[SimpleNamespace(annotations=[_ann("url_citation", "https://a.com", "A")])])],
    usage=SimpleNamespace(input_tokens=10, output_tokens=5, total_tokens=15),
)

_orig_get_client = llm._get_client
llm._get_client = lambda: SimpleNamespace(responses=SimpleNamespace(stream=lambda **kw: _FakeStream(fake_events, fake_final)))
try:
    out = list(llm.stream_answer("q", SC))
finally:
    llm._get_client = _orig_get_client

tokens = [e for e in out if e["type"] == "token"]
tool_starts = [e for e in out if e["type"] == "tool_start"]
finals = [e for e in out if e["type"] == "final"]
check("token 이벤트 2개(델타 매핑)", [t["text"] for t in tokens] == ["안녕", " 끝"])
check("tool_start 2개(web_search·code_interpreter)", [t["tool"] for t in tool_starts] == ["web_search", "code_interpreter"])
check("같은 툴 중복 tool_start 없음", len(tool_starts) == 2)
check("final 1개", len(finals) == 1)
fin = finals[-1] if finals else {}
check("tools_used = screen_data + 호출툴(순서)", fin.get("tools_used") == ["screen_data", "web_search", "code_interpreter"])
check("citations 매핑", fin.get("citations") == [{"url": "https://a.com", "title": "A"}])
check("usage input→prompt/output→completion 매핑",
      (fin.get("trace") or {}).get("usage") == {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})

# 화면 없으면 tools_used 에 screen_data 미포함
llm._get_client = lambda: SimpleNamespace(responses=SimpleNamespace(stream=lambda **kw: _FakeStream([], fake_final)))
try:
    out_empty = list(llm.stream_answer("q", ScreenContext()))
finally:
    llm._get_client = _orig_get_client
fin_empty = [e for e in out_empty if e["type"] == "final"][-1]
check("화면 비면 screen_data 미포함", fin_empty["tools_used"] == [])

# web_search 단독(화면 있어도) → 외부 출처라 screen_data 미포함 (배지 변별력)
web_only = [_ev("response.web_search_call.searching"), _ev("response.output_text.delta", delta="시세 1,200원")]
llm._get_client = lambda: SimpleNamespace(responses=SimpleNamespace(stream=lambda **kw: _FakeStream(web_only, fake_final)))
try:
    out_web = list(llm.stream_answer("오늘 철근 시세?", SC))
finally:
    llm._get_client = _orig_get_client
fin_web = [e for e in out_web if e["type"] == "final"][-1]
check("web 단독이면 화면 있어도 screen_data 미포함", fin_web["tools_used"] == ["web_search"])

# 툴 미호출(화면만) → screen_data 만
llm._get_client = lambda: SimpleNamespace(responses=SimpleNamespace(stream=lambda **kw: _FakeStream([_ev("response.output_text.delta", delta="박지연")], fake_final)))
try:
    out_scr = list(llm.stream_answer("PM?", SC))
finally:
    llm._get_client = _orig_get_client
fin_scr = [e for e in out_scr if e["type"] == "final"][-1]
check("툴 미호출이면 screen_data 만", fin_scr["tools_used"] == ["screen_data"])

# DEV_MODE 게이트: 꺼지면 final 에 trace 미포함(프로덕션 안전), 켜지면 포함
check("DEV_MODE on → trace 포함", "trace" in fin_scr)  # 파일 상단에서 DEV_MODE=True
llm._get_client = lambda: SimpleNamespace(responses=SimpleNamespace(stream=lambda **kw: _FakeStream([], fake_final)))
config.settings.dev_mode = False
try:
    out_nodev = list(llm.stream_answer("q", SC))
finally:
    config.settings.dev_mode = True
    llm._get_client = _orig_get_client
fin_nodev = [e for e in out_nodev if e["type"] == "final"][-1]
check("DEV_MODE off → trace 미포함", "trace" not in fin_nodev)

# 예외 → error 이벤트(사용자에게 표시)
def _boom():
    raise RuntimeError("키 없음")

llm._get_client = _boom
try:
    out_err = list(llm.stream_answer("q", SC))
finally:
    llm._get_client = _orig_get_client
check("client 실패 → error 이벤트", len(out_err) == 1 and out_err[0]["type"] == "error" and "키 없음" in out_err[0]["message"])


# 4) /api/chat/stream SSE 프레이밍 (stub stream_answer) ───────────────────────
from fastapi.testclient import TestClient  # noqa: E402

import server.main as main  # noqa: E402

_stub_events = [
    {"type": "tool_start", "tool": "code_interpreter"},
    {"type": "token", "text": "현장-50"},
    {"type": "final", "tools_used": ["screen_data", "code_interpreter"], "citations": [], "trace": {"model": "stub"}},
]
_orig_stream = llm.stream_answer
llm.stream_answer = lambda q, sc, hist=None: iter(_stub_events)
try:
    client = TestClient(main.app)
    resp = client.post("/api/chat/stream", json={"question": "q", "screen_context": SC.model_dump()})
finally:
    llm.stream_answer = _orig_stream

check("SSE status 200", resp.status_code == 200)
check("content-type text/event-stream", resp.headers.get("content-type", "").startswith("text/event-stream"))
# "data: {json}\n\n" 블록마다 1 이벤트
blocks = [b for b in resp.text.split("\n\n") if b.strip()]
parsed = [json.loads(b[len("data: "):]) for b in blocks if b.startswith("data: ")]
check("SSE 이벤트 3개 프레이밍", len(parsed) == 3)
check("SSE 이벤트 내용 보존", parsed == _stub_events)


# ── 결과 ──
failed = [n for n, ok in _checks if not ok]
for n, ok in _checks:
    print(("  ok " if ok else "  FAIL ") + n)
print(f"\n{len(_checks) - len(failed)}/{len(_checks)} 통과")
sys.exit(1 if failed else 0)
