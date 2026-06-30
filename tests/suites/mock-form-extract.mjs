// 스위트: FormContext 추출 + 화면 식별 (browser) — 실제 Chromium + 목업 등록폼.
// FormExtractor 가 입력 컨트롤(필수·옵션·검색위젯·라인그리드·저장버튼)을 정확히 인식하는지와,
// ScreenIdentifier 가 딥링크 없이 DOM 시그니처로 "도착"을 판정하는지 본다.
import { openMock } from "../lib/mock.mjs";

const field = (form, label) => (form.fields || []).find((f) => (f.label || "") === label);

const CASES = [
  { id: "F1", name: "필수 텍스트 필드 인식(요청제목)",
    expect: "요청제목: role=text, required=true",
    assert: (c) => { const f = field(c.form, "요청제목"); return !!f && f.role === "text" && f.required === true; } },

  { id: "F2", name: "select 필드 + 옵션(부서)",
    expect: "부서: role=select, options=[총무팀,구매팀,연구개발팀], required",
    assert: (c) => { const f = field(c.form, "부서"); return !!f && f.role === "select" && f.required
      && JSON.stringify(f.options) === JSON.stringify(["총무팀", "구매팀", "연구개발팀"]); } },

  { id: "F3", name: "date 필드(납기일)",
    expect: "납기일: role=date, required",
    assert: (c) => { const f = field(c.form, "납기일"); return !!f && f.role === "date" && f.required === true; } },

  { id: "F4", name: "라인 그리드 + 검색위젯 인식",
    expect: "line_grid 존재, itemSearch=true, addRowBtn=#add-line, 컬럼에 품목/수량/단가/금액",
    assert: (c) => { const g = c.form.line_grid; return !!g && g.itemSearch === true && g.addRowBtn === "#add-line"
      && ["품목", "수량", "단가", "금액"].every((x) => g.columns.includes(x)); } },

  { id: "F5", name: "저장 버튼 인식",
    expect: "save_button.key=#save-btn",
    assert: (c) => !!c.form.save_button && c.form.save_button.key === "#save-btn" },

  { id: "F6", name: "라인 그리드 안쪽 칸은 최상위 fields 에서 제외",
    expect: "fields 는 헤더 3개(제목·부서·납기)만 — 수량/단가 등 그리드 칸 미포함",
    assert: (c) => (c.form.fields || []).length === 3 },

  { id: "S1", name: "도착 감지: 등록폼 시그니처",
    expect: "screen=pr-form, hasSave=true, hasGrid=true",
    assert: (c) => c.formSig.screen === "pr-form" && c.formSig.hasSave === true && c.formSig.hasGrid === true },

  { id: "S2", name: "도착 감지: 홈 ≠ 폼(딥링크 없이 DOM 시그니처로 구별)",
    expect: "home: screen=home, hasSave=false, hasGrid=false",
    assert: (c) => c.homeSig.screen === "home" && c.homeSig.hasSave === false && c.homeSig.hasGrid === false },
];

export default {
  id: "mock-form-extract",
  title: "FormContext 추출 · 화면 식별",
  kind: "browser",
  description: "실제 Chromium + 목업 등록폼에서 FormExtractor(필드/필수/옵션/검색위젯/라인그리드/저장버튼)와 ScreenIdentifier(DOM 시그니처 도착감지) 검증.",
  cases: CASES,
  async setup() {
    const ctx = await openMock();
    await ctx.load();                  // 홈
    ctx.homeSig = await ctx.signature();
    await ctx.load("pr-form");          // 메뉴로 폼 이동
    ctx.formSig = await ctx.signature();
    ctx.form = await ctx.extractForm();
    return ctx;
  },
  async teardown(ctx) { if (ctx) await ctx.close(); },
  async run(testCase, ctx) {
    const ok = !!testCase.assert(ctx);
    return { ok, note: ok ? "" : `FAIL — form=${JSON.stringify(ctx.form).slice(0, 200)}` };
  },
};
