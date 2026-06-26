# Plan — 추출 레시피(recipe) 스키마 정의

> 작성: 2026-06-26 · 방식: `/plan-plus` (브레인스토밍 강화 PDCA Plan)
> 대상: 익스텐션 추출 레시피(recipe)의 **담을 내용(스키마) 재정의·확정**
> 상태: Plan 확정 대기 → 승인 시 `/pdca design recipe-schema`

---

## Executive Summary

| 관점 | 내용 |
|---|---|
| **Problem** | 도메인마다 화면 구성이 제각각이고 메뉴·광고 등 의미 없는 섹션이 많아, 익스텐션이 "어디가 본문인지" 모른 채 화면 전체를 긁어 노이즈가 섞인다. 기존 recipe는 표/카드 컬럼을 직접 정의(components)하는 무거운 구조라 잘 안 쓰인다(`_RULES=[]`). |
| **Solution** | recipe를 **"구조화 명세"에서 "콘텐츠 영역 지정 + 접근/보호 힌트"로 재정의.** 핵심은 `scope.include/exclude`로 본문 영역만 읽고 노이즈를 버리는 것. 구조화(표/카드)는 어댑터에 위임. |
| **Function·UX 효과** | 도메인별로 본문 selector만 선언하면 **모든 추출 계층(구조화·generic·텍스트 폴백)이 본문에만 집중** → 게시판·대시보드의 노이즈 제거, 요약/질의 정확도 상승. 익스텐션 재설치 없이 서버 배포로 화면 대응 추가. |
| **Core Value** | "레거시 무수정 + 어떤 화면에도 대응"이라는 제품 전제를, **얇은 선언(recipe) 하나로 도메인 확장**할 수 있게 만든다. 복잡성은 어댑터에 두고 recipe는 단순 유지. |

---

## 1. User Intent Discovery (Phase 1)

- **핵심 문제**: 도메인마다 화면이 달라, 익스텐션이 읽어야 할 **본문(콘텐츠 영역)**을 알려줄 선언이 필요. 메뉴·기타 무의미 섹션은 제외해야 함.
- **대상 사용자**: 레시피 작성자(우리/운영) — 서버에 도메인별 recipe를 배포. 최종 사용자는 그 효과(정확한 답변)를 받음.
- **성공 기준**:
  1. 도메인별 본문 selector 선언만으로 **노이즈 없이 본문만** 추출된다.
  2. recipe는 **익스텐션 재설치 없이 서버 배포**로 갱신된다(`/api/recipe`).
  3. recipe가 없어도 기존 어댑터·폴백이 그대로 동작한다(점진 적용).

---

## 2. Alternatives Explored (Phase 2)

| 접근 | 요지 | 채택 |
|---|---|---|
| **A. 콘텐츠 영역 지정 중심** | recipe = 본문 `include`/노이즈 `exclude` + 매칭/힌트/보호. 구조화는 어댑터에 위임 | ✅ **채택** |
| B. 구조화 추출 중심(기존 유지) | recipe가 표/카드 컬럼·라벨을 직접 정의(components) | ❌ 무겁고 잘 안 쓰임. 컬럼 라벨 누락은 드뭄 → 복잡성 대비 효용 낮음 |
| C. 둘 다 동등 | A+B 모두 v1 | ❌ 범위·구현량 과다 |

**채택 근거**: 사용자 핵심 요구가 "본문 영역 지정"이고, 최근 추가된 **가시성 필터 + 보이는 텍스트 폴백**과 직접 시너지(scope가 폴백 노이즈를 정공법으로 해결). 구조화는 이미 어댑터가 충분히 담당.

---

## 3. YAGNI Review (Phase 3)

**포함 (확정): A · B · C · G · H**

| 그룹 | 필드 | 역할 |
|---|---|---|
| **A 메타** | `name` `version` `enabled` `description` | 식별·배포관리·토글 |
| **B 매칭** | `match.url`(glob/정규식, 복수) · `match.domWhen` · `priority` | 적용 조건. URL 같아도 DOM 단서로 화면 구분 |
| **C 콘텐츠영역** ★ | `scope.include` · `scope.exclude` | 본문만 읽고 노이즈 제외. **모든 추출 계층 공통 적용** |
| **G 데이터레이어** | `dataLayer.type` · `dataLayer.path`/`selector` | MAIN world 리더가 전체데이터 읽는 위치 힌트 |
| **H 거버넌스** | `mask` · `deny` | LLM 전송 전 PII 마스킹 · 추출 금지 |

**제거/보류 (버림)**

| 그룹 | 사유 |
|---|---|
| **D 구조화 컴포넌트(components)** | 컬럼 라벨 누락은 거의 없고, 있어도 그것 때문에 복잡성을 키울 필요 없음 → 구조화·라벨은 어댑터에 전적 위임 |
| **E 텍스트 캡처 제어(text)** | `scope`(C)가 텍스트 폴백에도 공통 적용되므로 중복 → 불필요 |
| **F 도메인 지식(glossary/derived)** | LLM 도메인 오해 완화용이나 지금 당장 불필요 → 추후 |
| **I 동적 렌더(waitFor)** | 필요한 화면이 생기면 추가 |

---

## 4. Recipe 스키마 (확정 정의)

```jsonc
{
  // A. 메타
  "name": "site-portal",          // 식별자 (source 표기: recipe:site-portal)
  "version": 1,                   // 레시피 버전(배포 추적)
  "enabled": true,                // on/off 토글
  "description": "현장 포털 상세",

  // B. 매칭 — 언제 적용하나
  "match": {
    "url": ["*/portal/site*", "/erp\\.corp\\/site\\/\\d+/"], // glob 또는 /정규식/ (복수 = OR)
    "domWhen": ".site-portal"      // (선택) 이 selector 존재 시에만 — URL 같아도 화면 구분
  },
  "priority": 10,                  // 다중 매칭 시 큰 값 우선

  // C. 콘텐츠 영역 — 구조화·generic·텍스트 폴백 '모두'에 적용 (★핵심)
  "scope": {
    "include": ["#contents", ".board-view"],              // 본문 영역(들). 비우면 body 전체
    "exclude": ["nav", ".gnb", ".lnb", "footer", ".ads"]  // 노이즈 제외
  },

  // G. 데이터레이어 힌트 — MAIN world 리더 보조
  "dataLayer": { "type": "global", "path": "window.GRID" }, // 또는 {type:"agGrid", selector:"#grid"}

  // H. 거버넌스
  "mask": [".ssn", ".tel"],        // LLM 전송 전 마스킹(값 일부 가림)
  "deny": [".internal-only"]       // 추출 자체 금지(보내지 않음)
}
```

### 필드 정의

- **A 메타** — `name`(필수, 식별·source 표기), `version`/`enabled`/`description`(선택).
- **B 매칭** — `match.url`: glob(`*` 와일드카드) 또는 `/.../` 정규식, 배열은 OR. `match.domWhen`(선택): 해당 selector가 있을 때만 적용(SPA에서 URL 동일·화면 상이 케이스). `priority`: 여러 recipe 매칭 시 선택 우선순위.
- **C scope** — `include`: 본문 컨테이너 selector 배열(없으면 `body` 전체). `exclude`: 그 안에서도 제외할 노이즈. **추출 오케스트레이터가 모든 계층(table·domStructure·텍스트 폴백)에 적용**: include 밖은 무시, exclude는 건너뜀.
- **G dataLayer** — 전체 데이터(가상스크롤 포함)를 읽을 위치 힌트. `type:"global"`+`path`(전역 변수 경로) / 향후 `type:"agGrid"`+`selector` 등. 없으면 기존 `readDataLayer` 기본 동작.
- **H 거버넌스** — `mask`: 매칭 요소의 텍스트를 마스킹 후 전송. `deny`: 매칭 요소는 추출에서 제외(전송 안 함). 내부 데이터 거버넌스(§4.7) 보강.

---

## 5. 동작·통합 (설계 개요 — 구현은 design 단계)

1. **매칭**: `background.fetchRecipe(url)` → 서버 `/api/recipe?url=` → `get_recipe_for_url`이 `match.url`(glob/정규식) + `priority`로 선택. `match.domWhen`은 페이지에서 검사.
2. **scope 적용**: `UDC.run(doc, recipe, ...)`이 recipe.scope를 받아 **모든 추출 계층에 전달** — 어댑터/generic/`collectVisibleText`가 include 루트 안에서만, exclude를 건너뛰며 동작.
3. **dataLayer**: `readDataLayer`가 recipe.dataLayer.path/type를 우선 사용(없으면 현재 `window.GRID` 기본).
4. **거버넌스**: 추출 결과 직전 단계에서 mask/deny 적용 후 `ScreenContext` 구성.
5. **점진 적용**: recipe가 없거나 일부 필드만 있으면 나머지는 기존 동작 그대로(폴백).

> 서버 스키마(`schemas.py`)에 recipe용 Pydantic 모델 추가 필요(현재 recipe는 dict로 통과). `recipe.js`의 `applyRecipe`(components 기반)는 **scope 적용기로 대체/축소**.

---

## 6. Out of Scope

- D 구조화 컴포넌트(components) — 제거. 구조화·컬럼 라벨은 어댑터가 담당.
- E text 세부 제어, F glossary/derived, I waitFor — 추후(v2 후보).
- React/Vue/WebSquare 실제 데이터 리더 구현 — 별도 과제(dataLayer 힌트는 그 보조).
- 브라우저 내 동작 자동 검증 — 헤드리스 불가, 수동 테스트.

---

## 7. Risks / 주의

- **scope를 전 계층에 일관 적용**하는 오케스트레이션 변경이 핵심 — 어댑터 인터페이스에 scope 전달 경로 추가 필요(design에서 확정).
- glob/정규식 매칭은 서버(`get_recipe_for_url`)와 도메인 selector 검사(클라이언트 domWhen)로 나뉨 — 책임 분리 명확히.
- mask/deny 누락 시 PII 유출 위험 → 거버넌스는 "fail-safe"(불확실하면 제외) 원칙.

---

## Brainstorming Log (Phases 1–4)

- recipe의 1차 역할: 범위 산정이 아니라 **담을 내용 재정의·확정**이 목적 (사용자 정정).
- scope(C) 적용 범위: **모든 추출 계층 공통**으로 확정.
- 포함 그룹: **A·B·C·G·H** / 버림: D·E·F·I.
- 매칭 수준: **URL 패턴(glob/정규식) + domWhen**.
- D(구조화 컴포넌트) 제거 확정: "컬럼 라벨 누락은 드물고, 그 때문에 복잡성을 키울 필요 없음" → 구조화는 어댑터에 위임.
