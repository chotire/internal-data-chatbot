# 테스트 결과 — internal-data-chatbot

> 2026-06-26 03:03:20 UTC · node tests/run.mjs
> **전체: 18 PASS / 0 FAIL / 0 SKIP** (18 케이스, 3 스위트)

## 요약

| 스위트 | 유형 | PASS | FAIL | SKIP |
|---|---|---:|---:|---:|
| 서버 recipe 검증(매칭·JSONC·스키마) | command | 1 | 0 | 0 |
| 핵심 어댑터 추출 | browser | 7 | 0 | 0 |
| recipe 추출 파이프라인 | browser | 10 | 0 | 0 |

## 서버 recipe 검증(매칭·JSONC·스키마)  `server-recipe`

uv run python tests/server/test_recipes.py — 종료코드 0=성공.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| S1 | URL 매칭/JSONC 파싱/스키마 검증 | 파이썬 체크 전부 통과(exit 0) | ✅ PASS | 8/8 통과 |

## 핵심 어댑터 추출  `core-extract`

실제 Chromium + demo.html 에서 recipe 없이 전체 추출 → table 라벨/단위/타입·dataLayer 전체 50행·가상스크롤 최댓값·인사카드·병합 dedup·차트·text 폴백의 '데이터 정확성' 검증.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| C1 | table 어댑터: 요약표 라벨/단위/숫자타입 | 컬럼 공종·'계약금액 합계'(단위 백만원, number)·현장수, 플랜트=988,000 | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |
| C2 | dataLayer(MAIN): 가상스크롤 전체 50행 + 컬럼정의 라벨 | 그리드 50행, 라벨 현장명/공종/계약금액/누적기성액, 계약금액 단위 백만원·number | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |
| C3 | 가상스크롤 핵심: 화면 밖 최댓값 행(MAIN 없으면 못 찾음) | 계약금액 최댓값 = 100,000 (현장-50) | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |
| C4 | dom-structure: 인사카드 라벨-값 매핑 | 담당 PM 카드, 성명=박지연 / 부서=토목사업부 / 연락처=010-9876-5432 | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |
| C5 | 병합 dedup: 보이는-행 ISO 그리드를 MAIN 50행에 흡수 | 10행 이상 표는 정확히 1개(50행) — 중복 그리드 없음 | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |
| C6 | 차트(MAIN Chart.instances): 제목/라벨/시리즈 값 | 차트 2개, 공종별 bar [주택,토목,플랜트,건축]=[912000,975000,988000,900000] | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |
| C7 | text 폴백: 구조화 안 된 보이는 텍스트 캡처 | 페이지 제목 '현장 관리 대시보드' 가 text 섹션에 포함 | ✅ PASS | tables=2 · charts=2 · source=dataLayer+table+domStructure+text |

## recipe 추출 파이프라인  `recipe-schema`

실제 Chromium 에서 demo.html 에 content scripts+readDataLayer 주입 → scope/domWhen/mask/deny·그리드/차트 scope·가시성·병합 검증.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| T0 | 회귀: recipe 없음 → 전체 추출 | 그리드50+요약표, PM카드, source=dataLayer+table+domStructure(+text) | ✅ PASS | source=dataLayer+table+domStructure+text |
| T1 | scope.include=['.empcard'] → 본문만(그리드·차트·요약표 제외) | PM만, tables=0, charts=0, recipe:inc, dataLayer 없음 | ✅ PASS | source=recipe:inc+domStructure |
| T2 | scope.exclude=['.empcard'] → PM 제외, 나머지 유지 | PM 없음, 그리드50 유지 | ✅ PASS | source=dataLayer+recipe:exc+table+domStructure+text |
| T3 | domWhen=#NOPE(불일치) → recipe 미적용(전체) | recipe 미표기, 그리드50 유지 | ✅ PASS | source=dataLayer+table+domStructure+text |
| T4 | domWhen=.empcard(일치) → include 적용 | tables=0, recipe:dw2 | ✅ PASS | source=recipe:dw2+domStructure |
| T5 | mask=['.v-tel'] → 연락처 가림 | 연락처=***, 성명=박지연 | ✅ PASS | source=dataLayer+recipe:m+table+domStructure+text |
| T6 | deny=['.empcard'] → 완전 제외 | PM 없음, 그리드50 유지 | ✅ PASS | source=dataLayer+recipe:d+table+domStructure+text |
| T7 | include + dataLayer 힌트 → 그리드 opt-in, 차트 제외 | 그리드50 포함, charts=0 | ✅ PASS | source=dataLayer+recipe:dl+domStructure |
| T8 | 차트 scope: exclude 로 worktype 차트 제외(실제 canvas) | 차트 2→1, 그리드 유지 | ✅ PASS | source=dataLayer+recipe:cx+table+domStructure+text |
| V1 | 가시성: 숨은 설치배너 텍스트 미포함(실제 getComputedStyle) | text 폴백에 '익스텐션 미감지/감지됨' 없음 | ✅ PASS | source=dataLayer+table+domStructure+text |

---
재실행: `node tests/run.mjs` · 케이스 추가: `tests/README.md` 참고
