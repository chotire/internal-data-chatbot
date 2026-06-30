# 테스트 결과 — internal-data-chatbot

> 2026-06-29 13:21:57 UTC · node tests/run.mjs
> **전체: 45 PASS / 0 FAIL / 0 SKIP** (45 케이스, 8 스위트)

## 요약

| 스위트 | 유형 | PASS | FAIL | SKIP |
|---|---|---:|---:|---:|
| 서버 recipe 검증(매칭·JSONC·스키마) | command | 1 | 0 | 0 |
| 서버 툴-콜링/스트리밍 검증(이벤트 매핑·SSE) | command | 1 | 0 | 0 |
| 서버 두뇌 fill-plan/그래프 검증(의도·계획·게이트) | command | 1 | 0 | 0 |
| 핵심 어댑터 추출 | browser | 7 | 0 | 0 |
| recipe 추출 파이프라인 | browser | 10 | 0 | 0 |
| FormContext 추출 · 화면 식별 | browser | 8 | 0 | 0 |
| 액션 프리미티브 · 안전입력 · 전체 루프 | browser | 8 | 0 | 0 |
| PlanExecutor — fill-plan 실행 | browser | 9 | 0 | 0 |

## 서버 recipe 검증(매칭·JSONC·스키마)  `server-recipe`

uv run python tests/server/test_recipes.py — 종료코드 0=성공.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| S1 | URL 매칭/JSONC 파싱/스키마 검증 | 파이썬 체크 전부 통과(exit 0) | ✅ PASS | 8/8 통과 |

## 서버 툴-콜링/스트리밍 검증(이벤트 매핑·SSE)  `server-stream`

uv run python tests/server/test_stream.py — 종료코드 0=성공. stream_answer 이벤트 매핑·citations·_build_messages·/api/chat/stream SSE 프레이밍(OpenAI 스텁).

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| ST1 | 툴-콜링 이벤트 매핑/citations/SSE 프레이밍 | 파이썬 체크 전부 통과(exit 0) | ✅ PASS | 26/26 통과 |

## 서버 두뇌 fill-plan/그래프 검증(의도·계획·게이트)  `server-plan`

uv run python tests/server/test_plan.py — 종료코드 0=성공. parse_intent·plan(fill-plan)·decide_gate·FileGraphStore·/api/agent/plan(MockBrain 결정론).

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| PL1 | 의도 파싱·fill-plan·게이트·그래프·엔드포인트 | 파이썬 체크 전부 통과(exit 0) | ✅ PASS | 51/51 통과 |

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

## FormContext 추출 · 화면 식별  `mock-form-extract`

실제 Chromium + 목업 등록폼에서 FormExtractor(필드/필수/옵션/검색위젯/라인그리드/저장버튼)와 ScreenIdentifier(DOM 시그니처 도착감지) 검증.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| F1 | 필수 텍스트 필드 인식(요청제목) | 요청제목: role=text, required=true | ✅ PASS |  |
| F2 | select 필드 + 옵션(부서) | 부서: role=select, options=[총무팀,구매팀,연구개발팀], required | ✅ PASS |  |
| F3 | date 필드(납기일) | 납기일: role=date, required | ✅ PASS |  |
| F4 | 라인 그리드 + 검색위젯 인식 | line_grid 존재, itemSearch=true, addRowBtn=#add-line, 컬럼에 품목/수량/단가/금액 | ✅ PASS |  |
| F5 | 저장 버튼 인식 | save_button.key=#save-btn | ✅ PASS |  |
| F6 | 라인 그리드 안쪽 칸은 최상위 fields 에서 제외 | fields 는 헤더 3개(제목·부서·납기)만 — 수량/단가 등 그리드 칸 미포함 | ✅ PASS |  |
| S1 | 도착 감지: 등록폼 시그니처 | screen=pr-form, hasSave=true, hasGrid=true | ✅ PASS |  |
| S2 | 도착 감지: 홈 ≠ 폼(딥링크 없이 DOM 시그니처로 구별) | home: screen=home, hasSave=false, hasGrid=false | ✅ PASS |  |

## 액션 프리미티브 · 안전입력 · 전체 루프  `action-primitives`

실제 Chromium + 목업 등록폼에서 안전입력(controlled input 모델 반영) vs 단순 주입(대조군)·검색팝업(볼펜→3종)·자동계산·미리보기→확인→저장→결과 루프 검증.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| AP1 | 안전입력: controlled input 모델 반영 | fill 후 모델 거울(echo)에 값 반영, readBack=값 | ✅ PASS | readBack=사무용품 보충 · echo=모델값: 사무용품 보충 |
| AP2 | 대조군: 단순 .value 주입은 모델 미반영 | 화면값은 바뀌어도 모델 거울은 (빈값) — 안전입력만이 모델을 바꾼다 | ✅ PASS | 화면값=주입된값 · 모델거울=모델값: (빈값) |
| AP3 | select 안전 선택(부서) | select 후 값=총무팀, 모델 거울 반영 | ✅ PASS | echo=모델값: 총무팀 |
| AP4 | searchSelect: '볼펜' → 후보 3종(흑/청/적) | 검색팝업 후보 3개 반환(정식코드 찾기 + HITL 대상) | ✅ PASS | 후보=P-1001,P-1002,P-1003 |
| AP5 | 검색선택 + 수량 → 자동계산(금액·합계 readonly) | 볼펜(흑) P-1001 선택·수량10 → 단가500·금액5000·합계5000 | ✅ PASS | 단가=500 금액=5000 합계=5000 |
| AP6 | 행추가 + 두 번째 라인 → 합계 누적 | 볼펜10(5000) + 스테이플러2(7000) → 합계 12000 | ✅ PASS | 합계=12000 |
| AP7 | 저장 검증: 필수 누락 → 확인모달 안 뜸 + 에러 | 빈 폼에서 저장 → confirm 모달 hidden, 에러에 '필수' | ✅ PASS | 모달=false 에러=요청제목은 필수입니다.부서는 필수입니다.납기일은 필수입니다.품목을 1건  |
| AP8 | 전체 루프: 채움 → 미리보기(게이트) → 확인 → 저장 → 결과 | 유효 입력 후 저장 → 확인모달 → 확인 → 결과화면, 요청번호 PR-2026-0042 | ✅ PASS | 모달=true 화면=result 요청번호=PR-2026-0042 |

## PlanExecutor — fill-plan 실행  `action-runplan`

실제 Chromium + 목업에서 서버 모양의 fill-plan 을 UDCA.runPlan 으로 실행 → 채움 순서·검색선택 해소(자동/지정)·저장 게이트(채우기만 vs 채우고 등록)·실패 중단 검증.

| # | 시나리오 | 기대 | 결과 | 비고 |
|---|---|---|---|---|
| RP1 | 채우기만(commitSave=false): 채움 + 저장 클릭 → 확인 대기 | 헤더·라인 채움, 볼펜 첫 후보 자동선택(P-1001), 합계 12000, 확인 모달 대기(prNo 없음) | ✅ PASS | auto=P-1001 합계=12000 모달=true 대기=true |
| RP2 | 후보 지정(resolutions): 볼펜 → 적(P-1003) 강제 선택 | row0 picked=P-1003(자동선택 아님), 단가 600·금액 6000 | ✅ PASS | picked=P-1003 단가=600 금액=6000 |
| RP3 | 채우고 등록(commitSave=true): 확인까지 → 결과 화면 | committed=true, 결과 화면 도착(screen=result), 요청번호 PR-2026-0042 | ✅ PASS | committed=true 화면=result 번호=PR-2026-0042 |
| RP4 | 실패 중단: 잘못된 대상이면 멈추고 보고 | ok=false, failedAt 존재, 이후 단계 미실행 | ✅ PASS | ok=false error=대상 없음: #does-not-exist |
| RP5 | 조회: 홈→목록 이동 후 읽기 | nav 후 read.kind=list, 행≥2, 화면=pr-list | ✅ PASS | read=list 행=2 화면=pr-list |
| RP6 | 삭제: 홈→목록 이동 → 행 삭제 → 확인 | PR-2026-0041 행 사라짐, 화면=pr-list | ✅ PASS | 삭제후존재=false 화면=pr-list |
| RP7 | 수정: 홈→목록→상세→수정 이동 → 부서 변경 → 저장 | 화면=pr-detail, 부서=구매팀(diff 반영) | ✅ PASS | 화면=pr-detail 부서=구매팀 |
| RP8 | 등록: 홈→폼 이동 → 채움 → 등록(채우고 등록) | nav 후 등록 완료, 요청번호 PR-2026-0042 | ✅ PASS | 번호=PR-2026-0042 화면=result |
| RP9 | 매핑: 메뉴 읽기전용 순회 → 화면·폼 수집 | home/pr-list/pr-form 관찰, pr-form 폼스키마 3필드 + 라인그리드 | ✅ PASS | ids=home,pr-list,pr-form 폼필드=3 |

---
재실행: `node tests/run.mjs` · 케이스 추가: `tests/README.md` 참고
