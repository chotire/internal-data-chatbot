"""포트(교체 지점) — 호출부는 "파일인지 그래프DB인지, 규칙인지 LangGraph인지" 모른다.

인터페이스는 파일 편의가 아니라 *실제 그래프DB·LangGraph 의 수요* 기준으로 설계한다
(docs/architecture/v0.4-action-agent.md §11). 그래야 교체가 "한 모듈 갈아끼우기"로 끝난다.
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable

from server.agent.schemas import (
    ActionStep,
    FillPlan,
    FormContext,
    FormSchema,
    GateDecision,
    GraphDiff,
    Intent,
    PlannedAction,
)


@runtime_checkable
class GraphStore(Protocol):
    """사내 시스템 지식 그래프 — 화면(노드)·이동(엣지)·폼 스키마를 보관/질의.

    지금: FileGraphStore(JSON). 나중: 실 그래프DB(Neo4j 등) 어댑터.
    """

    def match_screen(self, signature: dict) -> str | None:
        """DOM 시그니처로 "지금 어느 화면"인지 → screenId(없으면 None)."""
        ...

    def get_form_schema(self, screen_id: str) -> FormSchema | None:
        """폼 화면의 필드 스키마(Planner 가 fill-plan 생성에 사용)."""
        ...

    def find_path(self, from_screen: str, to_form: str) -> list[ActionStep]:
        """현재 화면 → 목표 폼 최단 이동 경로(메뉴 클릭 시퀀스/딥링크). 블라인드 탐색 아님."""
        ...

    def upsert_node(self, node: dict) -> None: ...

    def upsert_edge(self, edge: dict) -> None: ...

    def diff(self, live: dict, stored_screen_id: str) -> GraphDiff:
        """라이브 화면 vs 저장 그래프 비교(수동 유지·drift 감지의 토대)."""
        ...


@runtime_checkable
class Memory(Protocol):
    """에이전트 메모리 — 과거 해소결과(예: "볼펜"→정식코드)를 저장해 다음에 재사용.

    쌓일수록 "후보 고르기" 같은 잦은 확인(HITL)이 줄어든다(§2). 지금: FileMemory(JSON). 나중: Mem0/Zep.
    """

    def resolve(self, term: str) -> str | None:
        """자연어 항목 → 기억해 둔 정식코드(없으면 None)."""
        ...

    def remember(self, term: str, code: str) -> None:
        """해소결과를 적재(다음 계획에서 자동 사용)."""
        ...


@runtime_checkable
class Brain(Protocol):
    """에이전트 두뇌 — 의도 해석·계획·게이트 결정.

    지금: MockBrain(규칙기반, LLM 미사용 → 결정론 테스트). 나중: LangGraph 에이전트.
    """

    def parse_intent(self, text: str) -> Intent:
        """자연어 → 구조화 작업(작업·대상·라인·파라미터)."""
        ...

    def plan(self, intent: Intent, form: FormContext, graph: "GraphStore | None" = None,
             memory: "Memory | None" = None) -> FillPlan:
        """의도 + FormContext(+그래프+메모리) → 검사 가능한 fill-plan(어느 칸에 무슨 값) + 저장액션 + 게이트.

        메모리가 있으면 라인 품목을 기억된 정식코드로 자동 해소해 HITL(후보 고르기)을 줄인다.
        """
        ...

    def decide_gate(self, action: PlannedAction, ctx: dict | None = None) -> GateDecision:
        """위험등급×신뢰도×모드 → 물을지(confirm)/그냥 할지(auto)."""
        ...
