"""서버측 recipe 검증 — 매칭/JSONC 파싱/스키마. (pytest 불필요, 단독 실행)

실행: uv run python tests/server/test_recipes.py   (종료코드 0=성공)
command 유형 스위트가 이 파일을 호출해 결과를 tests/RESULTS.md 에 기록한다.
"""

from __future__ import annotations

import pathlib
import sys

# 파일로 직접 실행해도 프로젝트 루트를 import 경로에 넣는다(server 패키지 인식).
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))

from pydantic import ValidationError

from server.recipes import _match_url, _strip_jsonc, get_recipe_for_url
from server.schemas import Recipe

_checks: list[tuple[str, bool]] = []


def check(name: str, cond: bool) -> None:
    _checks.append((name, bool(cond)))


# 1) URL 매칭: glob / 정규식 / 비매칭
check("glob 매칭", _match_url(["*/portal/site*"], "https://x/portal/site/3") is True)
check("정규식 매칭", _match_url(["/site\\/\\d+/"], "https://x/site/42") is True)
check("비매칭", _match_url(["*/portal/site*"], "https://x/board") is False)

# 2) JSONC: 주석 제거 + 문자열 내 '//' 보존
src = '[ {"name":"a", "match":{"url":["https://x//y"]}} ] // tail\n/* block */'
stripped = _strip_jsonc(src)
check("JSONC 주석 제거", "//" in stripped and "tail" not in stripped and "block" not in stripped)
check("문자열 내 // 보존", "https://x//y" in stripped)

# 3) 스키마: name 누락은 검증 실패
try:
    Recipe(match={"url": ["*x*"]})
    check("name 누락 거부", False)
except ValidationError:
    check("name 누락 거부", True)

# 4) 스키마: 정상 recipe dump 형태
r = Recipe(name="t", match={"url": ["*x*"]}, scope={"include": [".a"]}, priority=3)
d = r.model_dump()
check("dump 필드 보존", d["name"] == "t" and d["scope"] == {"include": [".a"]} and d["priority"] == 3)

# 5) 실제 recipes.jsonc: 로드되며(예제 비활성) 매칭은 None
check("기본 recipes.jsonc 비활성 → None", get_recipe_for_url("http://localhost:8000/demo") is None)

# ── 결과 ──
failed = [n for n, ok in _checks if not ok]
for n, ok in _checks:
    print(("  ok " if ok else "  FAIL ") + n)
print(f"\n{len(_checks) - len(failed)}/{len(_checks)} 통과")
sys.exit(1 if failed else 0)
