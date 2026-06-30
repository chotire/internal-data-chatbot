"""FileGraphStore — GraphStore 포트의 파일(JSON) 어댑터. 1단계에선 골격이다.

화면·이동·폼스키마를 JSON 시드(server/data/site-graph.seed.json)에서 읽어 경로질의·폼스키마
조회·도착 매칭을 제공한다. 본격 사용(매핑 모드로 그래프 적재)은 로드맵 5단계이며, 그때
이 어댑터를 실 그래프DB 어댑터로 교체한다(호출부는 그대로).
"""

from __future__ import annotations

import json
from collections import deque
from pathlib import Path

from server.agent.ports import GraphStore
from server.agent.schemas import ActionStep, FormSchema, GraphDiff


class FileGraphStore(GraphStore):
    def __init__(self, path: str | Path):
        self.path = Path(path)
        data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        self.nodes: dict[str, dict] = {n["id"]: n for n in data.get("nodes", [])}
        self.edges: list[dict] = list(data.get("edges", []))

    # ── 질의 ─────────────────────────────────────────────────────────────
    def match_screen(self, signature: dict) -> str | None:
        signature = signature or {}
        screen = signature.get("screen")
        for nid, n in self.nodes.items():
            sig = n.get("signature") or {}
            if screen is not None and sig.get("screen") == screen:
                return nid
        return None

    def get_form_schema(self, screen_id: str) -> FormSchema | None:
        n = self.nodes.get(screen_id)
        if not n or "formSchema" not in n:
            return None
        return FormSchema.model_validate(n["formSchema"])

    def find_path(self, from_screen: str, to_form: str) -> list[ActionStep]:
        # 그래프 경로 탐색(BFS) — 블라인드 탐색이 아니라 결정론적 최단 경로.
        if from_screen == to_form:
            return []
        adj: dict[str, list[dict]] = {}
        for e in self.edges:
            adj.setdefault(e["from"], []).append(e)
        prev: dict[str, tuple[str, dict]] = {}
        seen = {from_screen}
        dq = deque([from_screen])
        while dq:
            cur = dq.popleft()
            if cur == to_form:
                break
            for e in adj.get(cur, []):
                nxt = e["to"]
                if nxt not in seen:
                    seen.add(nxt)
                    prev[nxt] = (cur, e)
                    dq.append(nxt)
        if to_form not in prev and from_screen != to_form:
            return []
        # 경로 복원 → 액션 시퀀스 평탄화
        steps: list[ActionStep] = []
        chain: list[dict] = []
        node = to_form
        while node in prev:
            parent, edge = prev[node]
            chain.append(edge)
            node = parent
        for edge in reversed(chain):
            for a in edge.get("actions", []):
                steps.append(ActionStep(op=a.get("op", "click"), target=a.get("target"), label=a.get("label")))
        return steps

    # ── 갱신(골격) ───────────────────────────────────────────────────────
    def upsert_node(self, node: dict) -> None:
        if node and node.get("id"):
            self.nodes[node["id"]] = node

    def upsert_edge(self, edge: dict) -> None:
        if not edge:
            return
        for i, e in enumerate(self.edges):
            if e.get("from") == edge.get("from") and e.get("to") == edge.get("to"):
                self.edges[i] = edge
                return
        self.edges.append(edge)

    def save(self, path: str | Path | None = None) -> None:
        """현재 그래프를 JSON 으로 영속(매핑 모드 적재 결과). 시드를 덮지 않도록 보통 live 파일로 저장."""
        p = Path(path) if path else self.path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(
            json.dumps({"nodes": list(self.nodes.values()), "edges": self.edges}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

    def diff(self, live: dict, stored_screen_id: str) -> GraphDiff:
        # 골격 — 화면 존재/시그니처 일치만 본다. 폼스키마 필드 diff 는 5단계(수동 유지)에서 확장.
        n = self.nodes.get(stored_screen_id)
        if not n:
            return GraphDiff(changed=True, added=[stored_screen_id], note="저장 그래프에 없는 화면(신규)")
        live_screen = (live or {}).get("screen")
        stored_screen = (n.get("signature") or {}).get("screen")
        changed = live_screen != stored_screen
        return GraphDiff(changed=changed, note="시그니처 불일치" if changed else "일치")
