"""추출 레시피(recipe) 로더 — 규칙은 코드가 아닌 데이터 파일(recipes.jsonc)에 둔다.

recipe 는 도메인별로 "어디가 콘텐츠 영역인지(scope) + 접근/거버넌스 힌트"를 선언한다.
구조화(표/카드)·라벨 매핑은 어댑터가 담당하고, recipe 는 그 위에 영역·힌트만 덧입힌다.

규칙을 `server/recipes.jsonc` 에 선언하면 서버가 매 요청마다 읽어 적용한다
(코드 아닌 config → 파일만 고치면 즉시 갱신, 재배포로 운영).
확장자 `.jsonc` = 주석(`//`, `/* */`) 허용(에디터도 정식 지원). 트레일링 콤마는 미지원.
매칭되는 recipe 가 없으면 None → 어댑터/데이터레이어/텍스트 폴백이 그대로 동작.
"""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path

from pydantic import ValidationError

from server.schemas import Recipe

_RECIPES_PATH = Path(__file__).parent / "recipes.jsonc"


def _strip_jsonc(text: str) -> str:
    """JSONC → JSON: 문자열 리터럴은 보존하면서 //줄주석, /* 블록주석 */ 만 제거."""
    out = []
    i, n = 0, len(text)
    in_str = esc = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
        elif c == '"':
            in_str = True
            out.append(c)
            i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
        elif c == "/" and i + 1 < n and text[i + 1] == "*":
            i += 2
            while i + 1 < n and not (text[i] == "*" and text[i + 1] == "/"):
                i += 1
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _load_recipes() -> list[Recipe]:
    """recipes.jsonc 을 읽어 Recipe 목록으로 검증. 파일 없음/깨짐/항목 오류는 건너뜀(폴백)."""
    try:
        text = _RECIPES_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    try:
        raw = json.loads(_strip_jsonc(text))
    except json.JSONDecodeError as e:
        print(f"[recipes] recipes.jsonc 파싱 실패: {e}")
        return []
    if not isinstance(raw, list):
        print("[recipes] recipes.jsonc 최상위는 배열이어야 합니다.")
        return []
    out: list[Recipe] = []
    for i, d in enumerate(raw):
        try:
            out.append(Recipe(**d))
        except ValidationError as e:
            print(f"[recipes] 항목 #{i} 무시(검증 실패): {e}")
    return out


def _match_url(patterns: list[str], url: str) -> bool:
    """patterns: glob('*' 와일드카드) 또는 '/regex/'(양끝 슬래시) — 배열은 OR."""
    for p in patterns:
        if len(p) >= 2 and p.startswith("/") and p.endswith("/"):  # 정규식
            try:
                if re.search(p[1:-1], url):
                    return True
            except re.error:
                continue
        elif fnmatch.fnmatch(url, p):  # glob
            return True
    return False


def get_recipe_for_url(url: str) -> dict | None:
    """URL 에 맞는(enabled) recipe 중 priority 최댓값을 dict 로 반환. 없으면 None."""
    if not url:
        return None
    cands = [r for r in _load_recipes() if r.enabled and _match_url(r.match.url, url)]
    if not cands:
        return None
    best = max(cands, key=lambda r: r.priority)
    return best.model_dump()
