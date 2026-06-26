"""데이터 표준 규격서 (Pydantic 모델).

이 파일은 "오가는 데이터가 어떤 형태여야 하는가"를 한곳에 못 박는 **계약(contract)** 이다.
실제 데이터가 아니라 *틀*이며, FastAPI/Pydantic 이 들어오고 나가는 데이터를 이 틀로 자동 검증한다.

크게 두 묶음:
  1) ScreenContext 계약  — 익스텐션의 모든 어댑터가 이 형태로 변환해 보내고, 서버·LLM 은 이 형태만 다룬다.
                           "화면이 무엇이든 뒷단은 동일"의 기준점. (CLAUDE.md §6 과 동일)
  2) Recipe 스키마       — recipes.jsonc(데이터)을 검증하는 틀. recipes.py 가 이 모델로 각 항목을 검증한다.

한 화면에는 표(여러 개) + 표 아닌 블록(인사카드 등) + 차트가 섞일 수 있어
ScreenContext = tables[] + sections[] + charts[] 로 구성한다.

────────────────────────────────────────────────────────────────────────
ScreenContext 예시 (POST /api/chat 의 screen_context):
{
  "source": "dataLayer+table+domStructure+text",   // 어떤 경로로 추출했나(추적용)
  "tables": [
    { "title": "현장 현황",
      "columns": [ {"key":"c3","label":"누적기성액","type":"number","unit":"백만원"}, ... ],
      "rows":    [ {"c0":"현장-01","c3":25500, ...}, ... ],
      "filters": {} }
  ],
  "sections": [
    { "kind":"card", "title":"담당 PM",
      "fields":[ {"label":"성명","value":"박지연"}, ... ] },
    { "kind":"text", "text":"게시글 본문처럼 구조화 안 된 보이는 텍스트..." }
  ],
  "charts": [
    { "id":"chart0", "title":"공종별 계약금액", "type":"bar",
      "labels":["주택","토목"], "series":[ {"name":"계약금액","data":[912000,975000]} ] }
  ]
}
────────────────────────────────────────────────────────────────────────
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

# 컬럼 데이터 타입. 어댑터가 값 분포를 보고 number/string 등을 정한다.
ColumnType = Literal["string", "number", "date"]


# ── 1) ScreenContext 계약 ──────────────────────────────────────────────

class Column(BaseModel):
    """표의 컬럼 정의(= 한 열의 의미). 예: {"key":"c3","label":"누적기성액","type":"number","unit":"백만원"}"""

    key: str                       # rows 의 각 행 dict 에서 이 컬럼 값을 찾는 키 (예: "c3")
    label: str | None = None       # 화면에 보이는 컬럼명. 헤더 없는 화면이면 None(의미 미상)
    type: ColumnType = "string"    # 값 타입(number 면 LLM 이 집계 가능)
    unit: str | None = None        # 단위(예: "백만원", "%") — 숫자 인용 시 함께 표기


class TableContext(BaseModel):
    """데이터 표 하나. columns(의미) + rows(데이터)를 합친 형태.

    예: { "title":"현장 현황",
          "columns":[{"key":"site","label":"현장명","type":"string","unit":null}, ...],
          "rows":[{"site":"현장-01","contract":51000}, ...], "filters":{} }
    """

    title: str | None = None                         # 표 제목(헤딩에서 캡처, 없으면 None)
    columns: list[Column]                            # 컬럼(의미) 목록
    rows: list[dict[str, Any]]                       # 행 목록. 각 행은 {컬럼key: 값} dict
    filters: dict[str, Any] = Field(default_factory=dict)  # 화면에 적용된 필터(있으면)


class SectionField(BaseModel):
    """카드/키값 블록의 한 줄(라벨-값). 예: {"label":"부서","value":"토목사업부"}"""

    label: str | None = None
    value: Any = None


class Section(BaseModel):
    """표가 아닌 블록.

    - kind="card"/"keyvalue" → fields(label/value) 사용. 예: 인사카드(성명/부서/연락처)
    - kind="text"            → text 사용. 구조화 못한 '보이는 텍스트 폴백'(게시글 본문 등)
    예: {"kind":"card","title":"담당 PM","fields":[{"label":"성명","value":"박지연"}]}
        {"kind":"text","text":"공지사항 본문 ..."}
    """

    kind: Literal["card", "keyvalue", "text"] = "card"
    title: str | None = None
    fields: list[SectionField] = Field(default_factory=list)  # card/keyvalue 일 때
    text: str | None = None                                   # text 일 때 내용


class ChartSeries(BaseModel):
    """차트의 한 계열(선/막대 하나). 예: {"name":"계약금액","data":[912000,975000]}"""

    name: str
    data: list[float]


class ChartContext(BaseModel):
    """차트 하나(원본 데이터 — canvas 픽셀이 아니라 값).

    예: {"id":"chart0","title":"공종별 계약금액","type":"bar",
         "labels":["주택","토목"],"series":[{"name":"계약금액","data":[912000,975000]}]}
    """

    id: str
    title: str
    type: Literal["bar", "grouped_bar", "line"]
    labels: list[str]                # x축 라벨
    series: list[ChartSeries]        # 계열들(같은 labels 공유)


class ScreenContext(BaseModel):
    """화면 1개에서 추출한 전체. 어댑터 출력이자 LLM 입력. 각 배열은 비어 있을 수 있다.

    예: {"source":"dataLayer+table+domStructure+text",
         "tables":[...], "sections":[...], "charts":[...]}
    """

    source: str | None = None        # 추출 경로 표기(예: "recipe:x+table+domStructure")
    tables: list[TableContext] = Field(default_factory=list)
    sections: list[Section] = Field(default_factory=list)
    charts: list[ChartContext] = Field(default_factory=list)


# ── 2) Recipe 스키마 (recipes.jsonc 검증용 틀) ──────────────────────────

class RecipeMatch(BaseModel):
    """이 레시피를 '언제' 적용할지. 예: {"url":["*/portal/site*"], "domWhen":".site-portal"}"""

    url: list[str] = Field(default_factory=list)  # glob("*") 또는 "/regex/"(양끝 슬래시). 배열=OR
    domWhen: str | None = None                    # 이 selector 가 화면에 있을 때만(클라이언트가 검사)


class RecipeDataLayer(BaseModel):
    """전체 데이터(가상스크롤 포함)를 읽을 위치 힌트. 예: {"type":"global","path":"window.GRID"}"""

    type: str = "global"             # "global"(전역 변수) | (향후) "agGrid" 등
    path: str | None = None          # 전역 경로. 예: "window.GRID"
    selector: str | None = None      # type=agGrid 등에서 그리드 DOM 지정(향후)


class Recipe(BaseModel):
    """도메인별 추출 레시피 — 콘텐츠 영역 지정(scope) + 접근/거버넌스 힌트.

    구조화(표/카드) 자체는 어댑터가 하고, recipe 는 "어디를 읽고/버리고, 어디서 데이터를 읽고,
    무엇을 가릴지"만 선언한다. 규칙은 recipes.jsonc 에 두며 이 모델로 검증된다.

    예시 한 건:
    {
      "name": "site-portal", "enabled": true,
      "match": { "url": ["*/portal/site*"], "domWhen": ".site-portal" },
      "priority": 10,
      "scope": { "include": ["#contents"], "exclude": ["nav", ".gnb"] },
      "dataLayer": { "type": "global", "path": "window.GRID" },
      "mask": [".ssn"], "deny": [".internal-only"]
    }
    """

    name: str                        # 식별자(추출 source 에 recipe:<name> 으로 표기)
    version: int = 1                 # 레시피 버전(배포 추적)
    enabled: bool = True             # off 면 매칭에서 제외
    description: str | None = None   # 사람용 설명
    match: RecipeMatch = Field(default_factory=RecipeMatch)  # 적용 조건(URL/domWhen)
    priority: int = 0                # 여러 레시피가 매칭되면 큰 값 우선
    # 콘텐츠 영역: {"include":[selector...], "exclude":[selector...]} — 모든 추출 계층에 공통 적용
    scope: dict[str, Any] = Field(default_factory=dict)
    dataLayer: RecipeDataLayer | None = None  # 전체 데이터 읽기 위치 힌트(MAIN world 리더 보조)
    mask: list[str] = Field(default_factory=list)  # 매칭 요소 값을 *** 로 가림(LLM 전송 전, best-effort)
    deny: list[str] = Field(default_factory=list)  # 매칭 요소는 추출 자체 금지(전송 안 함)


# ── API 입출력 ─────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    """POST /api/chat 요청 본문."""

    question: str                    # 사용자 질문
    screen_context: ScreenContext    # 익스텐션이 추출한 현재 화면 데이터(위 계약)
    # 이전 대화(텍스트 Q&A만). 각 항목 {role: "user"|"assistant", content: str}
    history: list[dict[str, Any]] = Field(default_factory=list)


class ChatResponse(BaseModel):
    """POST /api/chat 응답 본문."""

    answer: str                      # LLM 답변(마크다운)
    trace: dict[str, Any] | None = None  # 추적: 모델·토큰·지연·페이로드(챗봇 "어떻게 답했나")
