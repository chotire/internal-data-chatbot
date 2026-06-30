"""v0.4 행동 에이전트(김반장) — 서버측 "두뇌"(mock) + 포트.

뒷단(실 그래프DB·LangGraph)이 아직 없으므로 교체 지점을 포트(Protocol)로 못 박고,
지금은 파일/규칙기반 어댑터로 구현한다(docs/architecture/v0.4-action-agent.md §11).
나중에 어댑터만 갈아끼운다: FileGraphStore→실 그래프DB, MockBrain→LangGraph.
"""
