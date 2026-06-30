"""v0.4 행동 에이전트 규약(Pydantic) — ScreenContext(읽기)의 "쓰기판".

여기 모인 형식이 채널(익스텐션·JS)과 두뇌(서버·Python) 사이의 규약이다. 핵심은 **fill-plan**:
Planner 가 폼을 바로 채우지 않고 "어느 칸에 무슨 값"의 *검사 가능한 계획*을 먼저 만든다 →
안전(실행 전 확인)·HITL(계획 검토)·테스트(브라우저 없이 FormContext→plan 단위테스트)를 동시에 푼다.

읽기 규약(server/schemas.py 의 ScreenContext)과 역할이 다르므로 별도 모듈로 둔다(오염 금지).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# 입력 컨트롤의 종류. search=검색팝업으로만 고르는 칸(품목), readonly=자동계산(금액·합계).
FieldRole = Literal["text", "number", "date", "select", "search", "readonly", "lineitem"]
ActionKind = Literal["query", "create", "update", "delete"]


# ── FormContext (익스텐션 FormExtractor 의 출력 = Planner 입력) ───────────
class FormField(BaseModel):
    key: str                              # 안정적 핸들(셀렉터). 예: "#f-title"
    label: str | None = None
    role: FieldRole = "text"
    required: bool = False
    options: list[str] = Field(default_factory=list)  # select 의 선택지
    unit: str | None = None


class LineGrid(BaseModel):
    """라인 그리드(품목 행 묶음). 행추가 버튼·검색위젯 유무를 담는다."""

    key: str | None = None
    columns: list[str] = Field(default_factory=list)
    addRowBtn: str | None = None
    itemSearch: bool = False               # 품목을 검색팝업으로만 고르는가


class ButtonSpec(BaseModel):
    key: str
    label: str | None = None


class FormContext(BaseModel):
    screen_id: str | None = None
    signature: dict[str, Any] = Field(default_factory=dict)  # 도착 감지용 DOM 시그니처
    fields: list[FormField] = Field(default_factory=list)
    line_grid: LineGrid | None = None
    save_button: ButtonSpec | None = None


# ── Intent (IntentParser 출력) ────────────────────────────────────────────
class IntentLine(BaseModel):
    item: str                              # 자연어 품목명(예: "볼펜") — 정식코드는 Resolver 가 찾음
    qty: int = 1


class Intent(BaseModel):
    action: ActionKind = "create"
    target: str | None = None              # 대상(예: "구매요청")
    lines: list[IntentLine] = Field(default_factory=list)
    params: dict[str, Any] = Field(default_factory=dict)  # title/dept/due 등 헤더 값(있으면)


# ── Gate (위험×신뢰×모드 → 물을까/할까) ──────────────────────────────────
class GateDecision(BaseModel):
    mode: Literal["auto", "confirm"] = "auto"
    reason: str | None = None


class ActionStep(BaseModel):
    """이동(네비게이션) 한 걸음 — 메뉴/행 클릭 등. nav 시퀀스의 원소."""

    op: str = "click"
    target: str | None = None
    label: str | None = None


# ── fill-plan (핵심 축) ───────────────────────────────────────────────────
class FillPlanItem(BaseModel):
    op: Literal["fill", "select", "searchSelect", "addRow"]
    field_key: str | None = None           # 채울 칸(셀렉터). addRow 면 그리드/버튼.
    label: str | None = None
    value: Any = None
    row: int | None = None                 # 라인 그리드 행 인덱스(있으면)
    query: str | None = None               # searchSelect 검색어
    needs_resolution: bool = False         # "볼펜→3종" 처럼 후보 고르기(HITL) 필요
    note: str | None = None


class PlannedAction(BaseModel):
    op: str = "click"
    target: str | None = None
    value: Any = None
    irreversible: bool = False             # 저장·삭제 = 한 번 하면 끝
    gate: GateDecision | None = None


class FillPlan(BaseModel):
    intent: Intent
    nav: list["ActionStep"] = Field(default_factory=list)       # 대상 화면까지 이동(메뉴/행 클릭). 비면 이미 도착.
    items: list[FillPlanItem] = Field(default_factory=list)
    read: bool = False                                          # 조회: 도착 후 화면을 읽어 보고
    missing_required: list[str] = Field(default_factory=list)  # 못 채운 필수 칸 라벨(검사가능성)
    save: PlannedAction | None = None                           # 종료 행동(저장/삭제 클릭). 게이트가 붙는다.
    gate: GateDecision = Field(default_factory=GateDecision)    # 이 계획 실행 직전 게이트


# ── GraphStore 보조 타입 ──────────────────────────────────────────────────
class FormSchema(BaseModel):
    screen_id: str
    fields: list[FormField] = Field(default_factory=list)
    line_grid: LineGrid | None = None


class GraphDiff(BaseModel):
    changed: bool = False
    added: list[str] = Field(default_factory=list)
    removed: list[str] = Field(default_factory=list)
    note: str | None = None


# ── API ───────────────────────────────────────────────────────────────────
class PlanRequest(BaseModel):
    """POST /api/agent/plan 요청. intent 또는 intent_text 중 하나 + 현재 폼 정보."""

    intent: Intent | None = None
    intent_text: str | None = None
    form_context: FormContext | None = None
    screen_id: str | None = None           # form_context 없을 때 그래프에서 폼스키마 조회


class RememberRequest(BaseModel):
    """POST /api/agent/memory 요청 — 해소결과 적재(자연어 항목 → 정식코드)."""

    item: str
    code: str


class MapObservation(BaseModel):
    """매핑 모드 관찰 1건 — 한 화면의 시그니처 + (폼이면) 입력 컨트롤."""

    id: str                                # screenId(시그니처의 screen)
    title: str | None = None
    signature: dict[str, Any] = Field(default_factory=dict)
    form_context: FormContext | None = None
    via_target: str | None = None          # 이 화면으로 온 클릭 대상(엣지 기록용)
    from_id: str | None = None             # 직전 화면 id(엣지 from)


class MapRequest(BaseModel):
    """POST /api/agent/map 요청 — 관찰 묶음을 그래프에 적재(읽기전용 순회 결과)."""

    observations: list[MapObservation] = Field(default_factory=list)
