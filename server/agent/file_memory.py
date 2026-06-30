"""FileMemory — Memory 포트의 파일(JSON) 어댑터. 1단계 메모리(정식코드 해소 캐시).

"볼펜"→"P-1001" 같은 해소결과를 누적해 다음 계획에서 자동 사용 → 후보 고르기(HITL) 감소(§2·§8).
나중에 이 어댑터를 Mem0/Zep 등으로 교체한다(Memory 포트는 그대로). 본격 자기개선은 v0.6.
"""

from __future__ import annotations

import json
from pathlib import Path

from server.agent.ports import Memory


class FileMemory(Memory):
    def __init__(self, path: str | Path):
        self.path = Path(path)
        try:
            self.data = json.loads(self.path.read_text(encoding="utf-8")) if self.path.exists() else {}
        except Exception:
            self.data = {}
        self.data.setdefault("resolutions", {})  # { 자연어항목: 정식코드 }

    def resolve(self, term: str) -> str | None:
        return self.data["resolutions"].get((term or "").strip())

    def remember(self, term: str, code: str) -> None:
        term = (term or "").strip()
        if not term or not code:
            return
        self.data["resolutions"][term] = code
        self._save()

    def _save(self) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            pass  # 메모리 적재 실패는 치명적이지 않다(다음에 다시 해소).
