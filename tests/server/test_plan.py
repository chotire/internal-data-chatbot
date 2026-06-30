"""서버측 v0.4 두뇌(MockBrain) + 그래프(FileGraphStore) 검증 — LLM 없이 결정론.

검증 범위(브라우저 없이 고정 가능한 로직 = fill-plan 의 핵심 축):
  1) parse_intent : 자연어 → 작업·라인(품목/수량). 품목명 속 숫자(A4) 회피·분류어(MRO) 제거.
  2) plan         : FormContext + 의도 → fill-plan(올바른 field_key·searchSelect·자동행추가·needs_resolution).
  3) 검사가능성   : 필수 누락을 missing_required 로 먼저 드러냄.
  4) decide_gate  : 저장(되돌릴 수 없음) → confirm, 채우기 → auto.
  5) GraphStore   : match_screen·get_form_schema·find_path(골격).
  6) /api/agent/plan : form_context 없이 screen_id 만으로도 그래프 폼스키마로 계획 생성.

실행: uv run python tests/server/test_plan.py   (종료코드 0=성공)
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from server.agent.file_graph_store import FileGraphStore
from server.agent.mock_brain import MockBrain
from server.agent.schemas import FormContext, Intent, PlannedAction

_checks: list[tuple[str, bool]] = []


def check(name: str, cond: bool) -> None:
    _checks.append((name, bool(cond)))


brain = MockBrain()
graph = FileGraphStore("server/data/site-graph.seed.json")


def _form() -> FormContext:
    """그래프 폼스키마 → FormContext (main.py 의 폴백과 동일 구성)."""
    from server.agent.schemas import ButtonSpec

    sch = graph.get_form_schema("pr-form")
    return FormContext(
        screen_id="pr-form", fields=sch.fields, line_grid=sch.line_grid,
        save_button=ButtonSpec(key="#save-btn", label="저장"),
    )


# 1) parse_intent ─────────────────────────────────────────────────────────────
it = brain.parse_intent("MRO 볼펜10·스테이플러100·A4 23개 구매신청")
check("action=create", it.action == "create")
check("라인 3개", len(it.lines) == 3)
check("품목명 정리(MRO 제거)", [l.item for l in it.lines] == ["볼펜", "스테이플러", "A4"])
check("수량 매핑(품목 속 숫자 A4 회피)", [l.qty for l in it.lines] == [10, 100, 23])
check("삭제 의도", brain.parse_intent("PR-2026-0042 삭제해줘").action == "delete")
check("조회 의도", brain.parse_intent("구매요청 목록 보여줘").action == "query")
check("헤더 미지정이면 params 비어있음(라인만)", brain.parse_intent("볼펜10·스테이플러2 구매신청").params == {})

# 1b) parse_intent — 헤더(제목·부서·납기) 자연어 추출 + 라인 오염 없음 ────────────
ih = brain.parse_intent("제목: 사무용품 보충, 총무팀, 2026-07-15, 볼펜10·스테이플러2 구매신청")
check("제목 추출", ih.params.get("title") == "사무용품 보충")
check("부서 추출(…팀)", ih.params.get("dept") == "총무팀")
check("납기 추출(ISO)", ih.params.get("due") == "2026-07-15")
check("헤더가 라인을 오염시키지 않음", [(l.item, l.qty) for l in ih.lines] == [("볼펜", 10), ("스테이플러", 2)])
check("헤더 포함 의도 → plan 필수 누락 없음(끝까지 등록 가능)", brain.plan(ih, _form(), graph).missing_required == [])

# 2) plan (헤더 params 제공 → 필수 충족) ───────────────────────────────────────
form = _form()
it2 = Intent(action="create", lines=brain.parse_intent("볼펜10·스테이플러100·A4 23개 구매신청").lines,
             params={"title": "사무용품 보충", "dept": "총무팀", "due": "2026-07-15"})
plan = brain.plan(it2, form, graph)
by_key = {(i.op, i.field_key): i for i in plan.items}
check("제목 fill", ("fill", "#f-title") in by_key and by_key[("fill", "#f-title")].value == "사무용품 보충")
check("부서 select", ("select", "#f-dept") in by_key and by_key[("select", "#f-dept")].value == "총무팀")
check("납기 fill", ("fill", "#f-due") in by_key)

searches = [i for i in plan.items if i.op == "searchSelect"]
check("searchSelect 3개", len(searches) == 3)
check("searchSelect 검색어", [s.query for s in searches] == ["볼펜", "스테이플러", "A4"])
check("품목은 needs_resolution(후보 고르기 HITL)", all(s.needs_resolution for s in searches))
qtys = [i for i in plan.items if i.op == "fill" and i.field_key and i.field_key.startswith("[data-line-qty")]
check("수량 fill 3개·값", [q.value for q in qtys] == [10, 100, 23])
check("자동 행추가 2회(3라인)", len([i for i in plan.items if i.op == "addRow"]) == 2)
check("params 채우면 missing_required 없음", plan.missing_required == [])
check("저장 액션 존재·되돌릴 수 없음", plan.save is not None and plan.save.irreversible)
check("저장 게이트=confirm", plan.save.gate.mode == "confirm")
check("계획 게이트=confirm(저장 직전 사람 확인)", plan.gate.mode == "confirm")

# 3) 검사가능성 — params 없으면 필수 누락을 먼저 드러냄 ─────────────────────────
it3 = Intent(action="create", lines=brain.parse_intent("볼펜10 구매신청").lines)
plan3 = brain.plan(it3, form, graph)
check("필수 누락 표기(제목·부서·납기)",
      set(plan3.missing_required) == {"요청제목", "부서", "납기일"})

# 4) decide_gate ──────────────────────────────────────────────────────────────
check("되돌릴 수 없음 → confirm", brain.decide_gate(PlannedAction(op="click", irreversible=True)).mode == "confirm")
check("되돌릴 수 있음 → auto", brain.decide_gate(PlannedAction(op="fill", irreversible=False)).mode == "auto")

# 5) GraphStore 골격 ──────────────────────────────────────────────────────────
check("match_screen(home)", graph.match_screen({"screen": "home"}) == "home")
check("match_screen(미등록) → None", graph.match_screen({"screen": "없음"}) is None)
sch = graph.get_form_schema("pr-form")
check("get_form_schema 필드/검색위젯", [f.label for f in sch.fields] == ["요청제목", "부서", "납기일"] and sch.line_grid.itemSearch)
path = graph.find_path("home", "pr-form")
check("find_path home→pr-form 비어있지 않음", len(path) >= 1 and path[0].op == "click")

# 6) /api/agent/plan 엔드포인트 (form_context 없이 screen_id 만) ────────────────
from fastapi.testclient import TestClient  # noqa: E402

import server.main as main  # noqa: E402

client = TestClient(main.app)
resp = client.post("/api/agent/plan", json={
    "intent_text": "볼펜10·스테이플러100·A4 23개 구매신청", "screen_id": "pr-form",
})
check("엔드포인트 200", resp.status_code == 200)
body = resp.json()
check("엔드포인트 searchSelect 3개", len([i for i in body["items"] if i["op"] == "searchSelect"]) == 3)
check("엔드포인트 게이트=confirm", body["gate"]["mode"] == "confirm")
check("엔드포인트 필수누락 표기(form_context 없음)", set(body["missing_required"]) == {"요청제목", "부서", "납기일"})


# 7) 액션별 plan + 네비게이션 (조회·수정·삭제가 같은 루프) ───────────────────────
home = FormContext(screen_id="home", signature={"screen": "home"})

pc = brain.plan(brain.parse_intent("제목: 비품, 총무팀, 2026-07-15, 볼펜10 구매신청"), home, graph)
check("등록(홈에서): nav 가 등록폼으로 이동", any("pr-form" in (s.target or "") for s in pc.nav))
check("등록(홈에서): 그래프 폼스키마로 items 생성", any(i.field_key == "#f-title" for i in pc.items))
check("등록(홈에서): 헤더 제공 → 필수 누락 없음", pc.missing_required == [])

pq = brain.plan(brain.parse_intent("구매요청 목록 보여줘"), home, graph)
check("조회: nav 목록 + read=True + gate auto",
      any("pr-list" in (s.target or "") for s in pq.nav) and pq.read and pq.gate.mode == "auto")

pdl = brain.parse_intent("PR-2026-0041 삭제해줘")
check("삭제 의도 + PR 추출", pdl.action == "delete" and pdl.params.get("pr") == "PR-2026-0041")
pdlp = brain.plan(pdl, home, graph)
check("삭제: save=행 삭제 클릭(대상 PR), gate confirm",
      pdlp.save is not None and 'row-delete' in pdlp.save.target and "PR-2026-0041" in pdlp.save.target and pdlp.gate.mode == "confirm")
pdl0 = brain.plan(brain.parse_intent("구매요청 삭제해줘"), home, graph)
check("삭제: 대상 미지정 → missing_required, save 없음", bool(pdl0.missing_required) and pdl0.save is None)

pu = brain.plan(brain.parse_intent("PR-2026-0041 부서를 구매팀으로 수정"), home, graph)
check("수정: nav 상세→수정 진입", any("row-detail" in (s.target or "") for s in pu.nav) and any(s.target == "#edit-pr" for s in pu.nav))
check("수정: diff 항목(부서=구매팀)만, save confirm",
      [(i.field_key, i.value) for i in pu.items] == [("#f-dept", "구매팀")] and pu.gate.mode == "confirm")


# 8) 메모리 — 기억된 정식코드로 자동 해소(HITL 감소) ──────────────────────────
import os  # noqa: E402
import tempfile  # noqa: E402

from server.agent.file_memory import FileMemory  # noqa: E402

_tmp = os.path.join(tempfile.gettempdir(), "udc_test_memory.json")
try:
    if os.path.exists(_tmp):
        os.remove(_tmp)
except OSError:
    pass

mem = FileMemory(_tmp)
ss0 = [i for i in brain.plan(brain.parse_intent("볼펜10 구매신청"), _form(), graph, memory=mem).items if i.op == "searchSelect"][0]
check("메모리 비어있으면 후보 고르기 필요", ss0.needs_resolution and not ss0.value)
mem.remember("볼펜", "P-1003")
ss1 = [i for i in brain.plan(brain.parse_intent("볼펜10 구매신청"), _form(), graph, memory=mem).items if i.op == "searchSelect"][0]
check("메모리 적재 후 자동 해소(value=P-1003, needs_resolution False)", ss1.value == "P-1003" and not ss1.needs_resolution)
check("메모리 영속(파일에서 다시 읽힘)", FileMemory(_tmp).resolve("볼펜") == "P-1003")

# 9) 매핑 모드 — 관찰 적재 + 변이 엣지 denylist ──────────────────────────────
mres = client.post("/api/agent/map", json={"observations": [
    {"id": "home", "signature": {"screen": "home"}},
    {"id": "pr-list", "signature": {"screen": "pr-list"}, "from_id": "home", "via_target": '[data-nav="pr-list"]'},
    {"id": "pr-form", "signature": {"screen": "pr-form"}, "from_id": "home", "via_target": '[data-nav="pr-form"]',
     "form_context": {"screen_id": "pr-form",
                      "fields": [{"key": "#f-title", "label": "요청제목", "role": "text", "required": True}],
                      "line_grid": {"key": "#line-grid", "columns": ["품목"], "addRowBtn": "#add-line", "itemSearch": True}}},
    {"id": "result", "signature": {"screen": "result"}, "from_id": "pr-form", "via_target": "#save-btn"},  # 변이 → 제외
]})
check("매핑 200", mres.status_code == 200)
_mb = mres.json()
check("매핑: 노드 적재(≥4)", _mb["nodes"] >= 4)
check("매핑: 이동 엣지 적재", _mb["edges"] >= 2)
check("매핑: 변이 엣지(저장) denylist 로 제외", _mb["skippedMutateEdges"] >= 1)


# ── 결과 ──
failed = [n for n, ok in _checks if not ok]
for n, ok in _checks:
    print(("  ok " if ok else "  FAIL ") + n)
print(f"\n{len(_checks) - len(failed)}/{len(_checks)} 통과")
sys.exit(1 if failed else 0)
