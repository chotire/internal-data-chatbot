# Design — 추출 레시피(recipe) 스키마

> 작성: 2026-06-26 · 단계: PDCA Design
> Plan: [docs/01-plan/features/recipe-schema.plan.md](../../01-plan/features/recipe-schema.plan.md)
> 확정 구성: **A 메타 · B 매칭 · C scope · G dataLayer 힌트 · H 거버넌스** (D·E·F·I 제외)

---

## 1. 설계 목표

1. recipe를 "구조화 명세"가 아니라 **콘텐츠 영역 지정 + 접근/보호 힌트**로 동작시킨다.
2. `scope.include/exclude`를 **모든 추출 계층(table · domStructure · 텍스트 폴백)** 에 일관 적용한다.
3. recipe가 없거나 일부 필드만 있어도 **기존 동작으로 자연 폴백**한다(점진 적용).
4. PoC 단순성 유지 — 새 추상화 최소화, 기존 `claimed`/`isVisible` 메커니즘 재사용.

---

## 2. 데이터 계약 (서버 — `server/schemas.py`)

기존 `Recipe`는 dict로 통과했음 → Pydantic 모델로 명시(검증·문서화).

```python
class RecipeMatch(BaseModel):
    url: list[str] = Field(default_factory=list)   # glob("*") 또는 "/regex/" (배열=OR)
    domWhen: str | None = None                     # 이 selector 존재 시에만 (클라이언트 검사)

class RecipeDataLayer(BaseModel):
    type: str = "global"                           # "global" | (향후) "agGrid" ...
    path: str | None = None                        # 예: "window.GRID"
    selector: str | None = None                    # type=agGrid 등에서 사용(향후)

class Recipe(BaseModel):
    name: str
    version: int = 1
    enabled: bool = True
    description: str | None = None
    match: RecipeMatch = Field(default_factory=RecipeMatch)
    priority: int = 0
    scope: dict = Field(default_factory=dict)       # {"include":[...], "exclude":[...]}
    dataLayer: RecipeDataLayer | None = None
    mask: list[str] = Field(default_factory=list)
    deny: list[str] = Field(default_factory=list)
```

> `scope`는 단순 `{include:[],exclude:[]}` dict로 둔다(과한 모델링 회피). 익스텐션이 selector 문자열만 사용.

---

## 3. 매칭 (서버 — `server/recipes.jsonc` + `server/recipes.py`, `/api/recipe`)

### 레지스트리 = 데이터 파일 (`server/recipes.jsonc`)
규칙은 **코드가 아니라 JSON 파일**에 선언한다(config → 파일 수정만으로 갱신). 가독성을 위해 **주석(`//`,`/* */`) 허용(JSONC)** 이며, `recipes.jsonc` 안에 비활성(enabled:false) 예제가 내장돼 스키마 참고가 된다.
```jsonc
// recipes.jsonc (배열). 비어있으면 []
[
  { "name": "site-portal", "enabled": true,
    "match": { "url": ["*/portal/site*"], "domWhen": ".site-portal" },
    "priority": 10,
    "scope": { "include": ["#contents"], "exclude": ["nav", ".gnb"] } }
]
```
`recipes.py` 가 매 요청마다 읽어 `Recipe` 로 검증(잘못된 항목은 건너뜀) → 매칭.

### 선택 로직
```python
def get_recipe_for_url(url: str) -> dict | None:
    if not url: return None
    cands = [r for r in _load_recipes() if r.enabled and _match_url(r.match.url, url)]
    if not cands: return None
    best = max(cands, key=lambda r: r.priority)
    return best.model_dump()

def _match_url(patterns: list[str], url: str) -> bool:
    for p in patterns:
        if p.startswith("/") and p.endswith("/"):      # 정규식
            if re.search(p[1:-1], url): return True
        else:                                          # glob
            if fnmatch.fnmatch(url, p): return True
    return False
```

- **glob**: `fnmatch`(`*` 와일드카드). **정규식**: `/.../` 래핑 → `re.search`.
- **priority**: 다중 매칭 시 큰 값 선택.
- **domWhen**: 서버는 URL만 안다 → recipe에 그대로 실어 보내고 **클라이언트(background)가 검사**.
- `/api/recipe` 응답: `{ "recipe": <dump> | null }` (기존과 동일 형태).

---

## 4. 적용 (익스텐션) — 핵심 설계

### 4.1 background.js — fetch + domWhen 검사 + 인자 전달
- `fetchRecipe(url)`: 기존대로 `/api/recipe` 호출.
- **domWhen 검사**: recipe에 `match.domWhen`이 있으면, 추출 직전 `UDC.run` 내부 또는 주입 함수에서 `document.querySelector(domWhen)` 확인 → 없으면 recipe 무시(null 취급).
- `UDC.run(document, recipe, picked)` 로 recipe 전체 전달(현재 시그니처 유지).
- **dataLayer 힌트 전달**: `readDataLayer`를 인자 받도록 변경 →
  `executeScript({world:"MAIN", func: readDataLayer, args:[ recipe?.dataLayer || null ]})`.

### 4.2 scope 적용 — 오케스트레이터(`base.js UDC.run`)
**핵심 아이디어: include=스캔 루트 제한, exclude=`claimed` 선점.**

```
UDC.run(doc, recipe, pickedSelector):
  scope = recipe?.scope || {}
  # 1) domWhen 게이트
  if recipe?.match?.domWhen && !doc.querySelector(recipe.match.domWhen):
        recipe = null  # 이 화면 아님 → 폴백

  # 2) exclude: claimed 에 미리 넣어 모든 추출기가 건너뛰게
  claimed = []
  for sel in (scope.exclude||[]): claimed.push(...doc.querySelectorAll(sel))

  # 3) include: 스캔 루트(없으면 body)
  roots = []
  for sel in (scope.include||[]): roots.push(...visible(doc.querySelectorAll(sel)))
  if roots.length == 0: roots = [doc.body || doc.documentElement]

  # 4) picker(있으면 최우선) — 기존 유지
  # 5) 각 root 에 대해 어댑터 파이프라인 실행(merge)
  for root in roots:
      for adapter in sorted(adapters):
          if adapter.detect(root): merge(adapter.extract(root, claimed))
      # 차트·텍스트 폴백도 root 기준
      collectVisibleText(root, claimed) → text 섹션
```

- **어댑터 시그니처 변경**: `detect(scopeNode)` / `extract(scopeNode, claimed)` — `doc` 대신 **루트 노드**를 받는다. `node.querySelectorAll`은 element에도 동작하므로 변경 최소.
  - `table.js pickTable(scopeNode, claimed)`: `scopeNode.querySelectorAll("table")`.
  - `dom-structure.js extract(scopeNode, claimed)`: `domExtract(scopeNode, claimed)`.
  - `detect`도 동일 노드 기준.
- **exclude = claimed 선점**으로 자연 처리(기존 `UDC.overlaps` 재사용) → 별도 제외 로직 불필요.
- 차트(`extractChartIsland`)와 `collectVisibleText`도 root·claimed 기준으로 호출.
- **MAIN world(readDataLayer)도 scope 적용**(개정): `UDC.run` 이 domWhen 게이트 후 실효 scope/dataLayer 를 `result.appliedRecipe` 로 노출 → background 가 MAIN 리더에 전달.
  - **차트**: 각 Chart 인스턴스의 `canvas` DOM 위치로 필터(include 안 / exclude 밖).
  - **그리드(window.GRID)**: DOM 매핑이 없으므로 — `dataLayer.path` 힌트가 있으면 그 경로(명시 opt-in), 없고 `include` 가 지정되면 **전역 그리드 제외**(영역 밖). include 미지정이면 기존대로 `window.GRID` 읽기.

### 4.3 recipe.js — 역할 전환
- 기존 `applyRecipe`(components 추출)는 **제거**(D 폐기).
- 대신 **scope 해석 헬퍼**만 남기거나, 로직이 작으면 base.js에 흡수하고 `recipe.js` 파일 삭제.
  - 결정: **base.js로 흡수, `recipe.js` 삭제** (파일 수 감소, 단순화). `ADAPTER_FILES`에서 `content/recipe.js` 제거.

### 4.4 거버넌스 — mask / deny
- **deny**: `scope.exclude`와 동일하게 `claimed` 선점 → 추출/전송 안 됨. (구현 공유)
- **mask**: best-effort. deny처럼 완전 제외가 아니라 "있다는 건 알리되 값 가림"이 필요할 때.
  - 설계: 추출 후 `ScreenContext` 직렬화 직전, mask selector에 매칭된 요소의 **텍스트 문자열 집합**을 구해 결과 내 동일 문자열을 `***`로 치환(best-effort). PoC 범위에선 **deny 우선 구현, mask는 선택**.

---

## 5. 데이터 흐름

```
background: fetchRecipe(url) ──/api/recipe──> recipes.py(glob/regex+priority)
        │  recipe(JSON, match.domWhen 포함)
        ▼
ISOLATED: UDC.run(doc, recipe, picked)
        │  domWhen 게이트 → exclude/deny=claimed 선점 → include=roots
        │  roots × 어댑터(scoped) + collectVisibleText(scoped) → ScreenContext(부분)
MAIN: readDataLayer(recipe.dataLayer)  ── window[path] 등 → 표/차트(전체)
        ▼
background: 병합(표/차트=MAIN 우선, 카드/텍스트=ISOLATED) → mask 후처리 → ScreenContext
        ▼
서버 /api/chat → LLM
```

---

## 6. 변경 파일 목록

| 파일 | 변경 |
|---|---|
| `server/schemas.py` | `Recipe`/`RecipeMatch`/`RecipeDataLayer` 모델 추가 |
| `server/recipes.py` | `_RECIPES` 레지스트리 + `_match_url`(glob/regex) + priority 선택 |
| `server/main.py` | `/api/recipe` 응답 형태 유지(내부만 변경) |
| `extension/background.js` | `readDataLayer(hint)` 인자화 + `args` 전달, recipe 전달 유지 |
| `extension/content/base.js` | scope 오케스트레이션(roots/exclude/domWhen), 어댑터 root 기준 호출, recipe.js 흡수 |
| `extension/content/adapters/table.js` | `detect/extract`가 scopeNode 기준 |
| `extension/content/adapters/dom-structure.js` | `extract`가 scopeNode 기준(이미 root 파라미터 사용) |
| `extension/content/recipe.js` | **삭제** (applyRecipe 폐기), `ADAPTER_FILES`에서 제거 |
| `CLAUDE.md` | recipe 정의 갱신(scope 중심), 추출 계층/§4.5 반영 |

---

## 7. 엣지 케이스 / 결정

- **include selector가 화면에 없음** → 그 root 스킵. 모든 include가 없으면 `[body]` 폴백(전체) + 콘솔 경고.
- **scope 없는 recipe**(dataLayer/mask만) → roots=[body], exclude=[] → 기존 전체 추출 + 힌트만.
- **recipe 없음** → 현재 동작 그대로.
- **domWhen 불일치** → recipe 전체 무시(이 화면 아님).
- **picker와 scope 동시** → picker가 최우선(기존), 그 후 scope roots.
- **다중 include** → 각 root별 추출 후 merge(중복은 기존 `sameData` dedup).

---

## 8. 테스트 계획 (do 이후 check 대비)

- **서버 단위**: `_match_url` glob/regex/priority 케이스, `get_recipe_for_url` 반환 형태.
- **linkedom 추출**(가능 시): include로 특정 div만 추출되는지, exclude/deny가 제외되는지.
- **서버 200 + LLM**: scope 적용된 ScreenContext로 정상 응답.
- **수동(브라우저)**: 데모/게시판류에서 include로 본문만, exclude로 메뉴 제외, domWhen 분기. (헤드리스 불가)
- **회귀**: recipe 없을 때 기존 데모(`source="dataLayer+table+domStructure"`) 동일 동작.

---

## 9. Risks

- **어댑터 시그니처 변경(doc→scopeNode)** 이 회귀 위험의 핵심 — recipe 없을 때도 `roots=[body]`로 동일 경로를 타도록 보장.
- glob/regex 매칭 오류 시 과매칭/누락 → 레시피별 테스트 필수.
- mask는 문자열 치환 best-effort라 부분 노출 가능 → 민감 데이터는 **deny 우선** 권장.
- `recipe.js` 삭제 시 잔존 참조(`applyRecipe`, `ADAPTER_FILES`) 정리 누락 주의.

---

## 10. 구현 순서 (do 단계 체크리스트)

1. `schemas.py` Recipe 모델 → `recipes.py` 매칭(glob/regex/priority).
2. `base.js`: scope 오케스트레이션(exclude=claimed, include=roots, domWhen 게이트) + recipe.js 흡수.
3. 어댑터 `table.js`/`dom-structure.js` scopeNode 기준화 + `recipe.js` 삭제·참조 정리.
4. `background.js`: `readDataLayer(hint)` 인자화.
5. mask/deny(deny 먼저).
6. `CLAUDE.md` 갱신 + 회귀 확인(데모) + 예시 recipe 1개 등록.
