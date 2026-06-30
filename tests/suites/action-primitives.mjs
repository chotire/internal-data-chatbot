// 스위트: 액션 프리미티브 + 안전입력 + 전체 루프 (browser) — 실제 Chromium + 목업 등록폼.
// "비용이 채움으로 이동한다"(§1)를 진짜로 검증: controlled input 은 정확한 이벤트로만 모델이 바뀐다.
//  - 안전입력(native setter+이벤트) → 모델 반영 → 저장 성공.
//  - 단순 .value 주입(대조군) → 모델 미반영 → 저장 검증 실패.
// 그리고 검색팝업(볼펜→3종)·자동계산·미리보기(게이트)→확인→저장→결과 루프.
import { openMock } from "../lib/mock.mjs";

const SEARCH0 = '.item-search[data-row="0"]';
const SEARCH1 = '.item-search[data-row="1"]';

const CASES = [
  { id: "AP1", name: "안전입력: controlled input 모델 반영",
    expect: "fill 후 모델 거울(echo)에 값 반영, readBack=값",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.exec({ op: "fill", target: "#f-title", value: "사무용품 보충" });
      const echo = await ctx.echo("title");
      const ok = r.ok && r.readBack === "사무용품 보충" && /사무용품 보충/.test(echo || "");
      return { ok, note: `readBack=${r.readBack} · echo=${echo}` };
    } },

  { id: "AP2", name: "대조군: 단순 .value 주입은 모델 미반영",
    expect: "화면값은 바뀌어도 모델 거울은 (빈값) — 안전입력만이 모델을 바꾼다",
    run: async (ctx) => {
      await ctx.load("pr-form");
      await ctx.setRaw("#f-title", "주입된값");      // 이벤트 없이 .value 만
      const echo = await ctx.echo("title");
      const shown = await ctx.val("#f-title");
      const ok = shown === "주입된값" && /\(빈값\)/.test(echo || "") && !/주입된값/.test(echo || "");
      return { ok, note: `화면값=${shown} · 모델거울=${echo}` };
    } },

  { id: "AP3", name: "select 안전 선택(부서)",
    expect: "select 후 값=총무팀, 모델 거울 반영",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.exec({ op: "select", target: "#f-dept", value: "총무팀" });
      const echo = await ctx.echo("dept");
      return { ok: r.ok && r.readBack === "총무팀" && /총무팀/.test(echo || ""), note: `echo=${echo}` };
    } },

  { id: "AP4", name: "searchSelect: '볼펜' → 후보 3종(흑/청/적)",
    expect: "검색팝업 후보 3개 반환(정식코드 찾기 + HITL 대상)",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.exec({ op: "searchSelect", target: SEARCH0, query: "볼펜" });
      const ok = r.ok && (r.candidates || []).length === 3 && r.hitl === true;
      return { ok, note: `후보=${(r.candidates || []).map((c) => c.code).join(",")}` };
    } },

  { id: "AP5", name: "검색선택 + 수량 → 자동계산(금액·합계 readonly)",
    expect: "볼펜(흑) P-1001 선택·수량10 → 단가500·금액5000·합계5000",
    run: async (ctx) => {
      await ctx.load("pr-form");
      await ctx.exec({ op: "searchSelect", target: SEARCH0, query: "볼펜", value: "P-1001" });
      await ctx.exec({ op: "fill", target: '[data-line-qty="0"]', value: 10 });
      const price = await ctx.val('[data-line-price="0"]');
      const amount = await ctx.val('[data-line-amount="0"]');
      const total = await ctx.text("#grand-total");
      return { ok: price === "500" && amount === "5000" && total === "5000", note: `단가=${price} 금액=${amount} 합계=${total}` };
    } },

  { id: "AP6", name: "행추가 + 두 번째 라인 → 합계 누적",
    expect: "볼펜10(5000) + 스테이플러2(7000) → 합계 12000",
    run: async (ctx) => {
      await ctx.load("pr-form");
      await ctx.exec({ op: "searchSelect", target: SEARCH0, query: "볼펜", value: "P-1001" });
      await ctx.exec({ op: "fill", target: '[data-line-qty="0"]', value: 10 });
      await ctx.exec({ op: "addRow", target: "#add-line" });
      await ctx.exec({ op: "searchSelect", target: SEARCH1, query: "스테이플러", value: "P-2001" });
      await ctx.exec({ op: "fill", target: '[data-line-qty="1"]', value: 2 });
      const total = await ctx.text("#grand-total");
      return { ok: total === "12000", note: `합계=${total}` };
    } },

  { id: "AP7", name: "저장 검증: 필수 누락 → 확인모달 안 뜸 + 에러",
    expect: "빈 폼에서 저장 → confirm 모달 hidden, 에러에 '필수'",
    run: async (ctx) => {
      await ctx.load("pr-form");
      await ctx.exec({ op: "click", target: "#save-btn" });
      const modalShown = await ctx.visible("#confirm-modal");
      const errors = await ctx.text("#errors");
      return { ok: modalShown === false && /필수/.test(errors || ""), note: `모달=${modalShown} 에러=${(errors || "").slice(0, 40)}` };
    } },

  { id: "AP8", name: "전체 루프: 채움 → 미리보기(게이트) → 확인 → 저장 → 결과",
    expect: "유효 입력 후 저장 → 확인모달 → 확인 → 결과화면, 요청번호 PR-2026-0042",
    run: async (ctx) => {
      await ctx.load("pr-form");
      await ctx.exec({ op: "fill", target: "#f-title", value: "사무용품 보충" });
      await ctx.exec({ op: "select", target: "#f-dept", value: "총무팀" });
      await ctx.exec({ op: "fill", target: "#f-due", value: "2026-07-15" });
      await ctx.exec({ op: "searchSelect", target: SEARCH0, query: "볼펜", value: "P-1001" });
      await ctx.exec({ op: "fill", target: '[data-line-qty="0"]', value: 10 });
      // 저장 클릭 = 게이트(미리보기/확인). 모달이 떠야 한다(되돌릴 수 없는 행동).
      await ctx.exec({ op: "click", target: "#save-btn" });
      const modalShown = await ctx.visible("#confirm-modal");
      // 사람 확인(HITL 끝단) → 확인.
      await ctx.exec({ op: "click", target: "#confirm-ok" });
      const sig = await ctx.signature();
      const prNo = await ctx.text("#pr-no");
      const ok = modalShown === true && sig.screen === "result" && prNo === "PR-2026-0042";
      return { ok, note: `모달=${modalShown} 화면=${sig.screen} 요청번호=${prNo}` };
    } },
];

export default {
  id: "action-primitives",
  title: "액션 프리미티브 · 안전입력 · 전체 루프",
  kind: "browser",
  description: "실제 Chromium + 목업 등록폼에서 안전입력(controlled input 모델 반영) vs 단순 주입(대조군)·검색팝업(볼펜→3종)·자동계산·미리보기→확인→저장→결과 루프 검증.",
  cases: CASES,
  async setup() { return await openMock(); },
  async teardown(ctx) { if (ctx) await ctx.close(); },
  async run(testCase, ctx) {
    try {
      return await testCase.run(ctx);
    } catch (e) {
      return { ok: false, note: "예외: " + String((e && e.message) || e).slice(0, 120) };
    }
  },
};
