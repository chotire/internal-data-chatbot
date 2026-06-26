# 테스트

기능별 **스위트(suite)** 를 제너릭 러너가 실행하고, 결과를 **`tests/RESULTS.md`** 표로 기록한다.
새 기능은 스위트 파일 하나만 추가하면 같은 리포트에 합류한다.

## 실행

```bash
cd tests
npm run setup          # 최초 1회: playwright + chromium 설치
npm test               # = node run.mjs  (모든 스위트)
node run.mjs recipe-schema     # 특정 스위트만(id 로 필터)
```

- 결과: **`tests/RESULTS.md`** (요약 표 + 스위트별 상세) + 콘솔 출력
- 실패가 하나라도 있으면 exit code 1 → CI 연동 가능

## 구조

```
tests/
├── run.mjs                 # 진입점: 스위트 등록·실행·리포트
├── lib/
│   ├── runner.mjs          # 제너릭 러너(순회·집계·RESULTS.md 작성)
│   └── browser.mjs         # Playwright 하니스(데모 열기 + content scripts/readDataLayer 주입 + extract)
├── suites/                 # ★ 기능별 테스트 케이스 (여기에 추가)
│   ├── recipe-schema.mjs       # browser: recipe 추출 파이프라인
│   └── server-recipe.mjs       # command: 서버 파이썬 검증 실행
└── server/
    └── test_recipes.py     # 서버측 단독 파이썬 테스트(종료코드)
```

## 스위트 계약

`suites/<id>.mjs` 가 객체를 **default export**:

```js
export default {
  id: "my-feature",          // 고유 id (run.mjs 필터·리포트 키)
  title: "사람이 읽는 제목",
  kind: "browser" | "command" | "unit",   // 표시용 분류
  description: "한 줄 설명",   // (선택) 리포트에 표기
  cases: [ { id, name, expect, needs? } ],
  async setup() { return ctx; },           // (선택) 1회 준비 → run 에 전달
  async teardown(ctx) {},                  // (선택) 정리
  async run(testCase, ctx) {               // 케이스 1건 실행
    return { ok: true, note: "..." };      // 또는 { skip: true, note } / { ok: false, note }
  },
};
```

러너는 "어떻게 실행하는지" 를 모른다 — 순회·집계·리포트만 한다. 실행 방법은 스위트의 `run` 이 캡슐화.

## 스위트 추가 방법

1. `tests/suites/<id>.mjs` 작성(위 계약). 케이스마다 `id/name/expect` 와 판정 로직.
2. `tests/run.mjs` 의 `SUITES` 배열에 import 후 등록.
3. `node tests/run.mjs <id>` 로 단독 확인 → `npm test` 로 전체.

### 유형 가이드
- **browser**: 실제 Chromium 필요(추출/DOM/가시성/차트). `lib/browser.mjs` 의 `openDemo()` 재사용.
- **command**: 외부 명령/타 언어 테스트를 종료코드로 묶음(예: 파이썬 `test_recipes.py`). 케이스 단위는 보통 coarse.
- **unit**: 브라우저 없이 순수 JS 단언.

## 검증 범위 / 한계

- ✅ recipe scope·domWhen·mask/deny, MAIN world 그리드·차트 scope, 가시성 필터, 병합, 서버 매칭/JSONC/스키마
- ⚠️ 미검증(브라우저 보안 끝단): Chrome world 격리, side panel↔iframe `postMessage`·origin, 설치 감지 UI → 수동/시각 확인
- 차트 케이스(`needs:"chart"`)는 Chart.js 를 CDN 에서 로드 → 네트워크 없으면 SKIP
