// 스위트: PlanExecutor — fill-plan 실행 (browser) — 실제 Chromium + 목업 등록폼.
// 서버 두뇌가 만드는 것과 같은 모양의 fill-plan 픽스처를 UDCA.runPlan 으로 끝까지 돌려,
// "계획 → 동작" 런타임 접점을 검증한다(채움 순서·검색선택 자동/지정 해소·저장 게이트·결과 읽기).
// (실제 익스텐션 background↔sidepanel↔page 배선은 브라우저 런타임이라 수동 확인 — 여기선 실행 로직만.)
import { openMock } from "../lib/mock.mjs";

// 서버 /api/agent/plan 출력과 동일한 모양의 fill-plan(2라인: 볼펜·스테이플러).
function makePlan() {
  return {
    items: [
      { op: "fill", field_key: "#f-title", label: "요청제목", value: "사무용품 보충" },
      { op: "select", field_key: "#f-dept", label: "부서", value: "총무팀" },
      { op: "fill", field_key: "#f-due", label: "납기일", value: "2026-07-15" },
      { op: "searchSelect", field_key: '.item-search[data-row="0"]', label: "품목", query: "볼펜", row: 0, needs_resolution: true },
      { op: "fill", field_key: '[data-line-qty="0"]', label: "수량", value: 10, row: 0 },
      { op: "addRow", field_key: "#add-line", label: "행추가", row: 1 },
      { op: "searchSelect", field_key: '.item-search[data-row="1"]', label: "품목", query: "스테이플러", row: 1, needs_resolution: true },
      { op: "fill", field_key: '[data-line-qty="1"]', label: "수량", value: 2, row: 1 },
    ],
    save: { op: "click", target: "#save-btn", irreversible: true, gate: { mode: "confirm" } },
    gate: { mode: "confirm", reason: "되돌릴 수 없는 행동" },
  };
}
const ss = (res, row) => (res.results || []).find((r) => r.op === "searchSelect" && r.target.includes(`data-row="${row}"`));

const CASES = [
  { id: "RP1", name: "채우기만(commitSave=false): 채움 + 저장 클릭 → 확인 대기",
    expect: "헤더·라인 채움, 볼펜 첫 후보 자동선택(P-1001), 합계 12000, 확인 모달 대기(prNo 없음)",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.runPlan(makePlan(), { commitSave: false });
      const total = await ctx.text("#grand-total");
      const modal = await ctx.visible("#confirm-modal");
      const titleEcho = await ctx.echo("title");
      const ok = r.ok && r.awaitingConfirm === true && r.committed === false && !r.prNo
        && ss(r, 0).autoPicked === "P-1001" && total === "12000" && modal === true
        && /사무용품 보충/.test(titleEcho || "");
      return { ok, note: `auto=${ss(r, 0).autoPicked} 합계=${total} 모달=${modal} 대기=${r.awaitingConfirm}` };
    } },

  { id: "RP2", name: "후보 지정(resolutions): 볼펜 → 적(P-1003) 강제 선택",
    expect: "row0 picked=P-1003(자동선택 아님), 단가 600·금액 6000",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.runPlan(makePlan(), { commitSave: false, resolutions: { 0: "P-1003" } });
      const price = await ctx.val('[data-line-price="0"]');
      const amount = await ctx.val('[data-line-amount="0"]');
      const s0 = ss(r, 0);
      const ok = r.ok && s0.picked === "P-1003" && !s0.autoPicked && price === "600" && amount === "6000";
      return { ok, note: `picked=${s0.picked} 단가=${price} 금액=${amount}` };
    } },

  { id: "RP3", name: "채우고 등록(commitSave=true): 확인까지 → 결과 화면",
    expect: "committed=true, 결과 화면 도착(screen=result), 요청번호 PR-2026-0042",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.runPlan(makePlan(), { commitSave: true });
      const ok = r.ok && r.committed === true && r.prNo === "PR-2026-0042"
        && r.finalSignature && r.finalSignature.screen === "result";
      return { ok, note: `committed=${r.committed} 화면=${r.finalSignature && r.finalSignature.screen} 번호=${r.prNo}` };
    } },

  { id: "RP4", name: "실패 중단: 잘못된 대상이면 멈추고 보고",
    expect: "ok=false, failedAt 존재, 이후 단계 미실행",
    run: async (ctx) => {
      await ctx.load("pr-form");
      const r = await ctx.runPlan({ items: [{ op: "fill", field_key: "#does-not-exist", value: "x" }], save: null }, {});
      const ok = r.ok === false && !!r.failedAt && (r.results || []).length === 1;
      return { ok, note: `ok=${r.ok} error=${(r.error || "").slice(0, 30)}` };
    } },

  { id: "RP5", name: "조회: 홈→목록 이동 후 읽기",
    expect: "nav 후 read.kind=list, 행≥2, 화면=pr-list",
    run: async (ctx) => {
      await ctx.load(); // 홈에서 시작
      const plan = { intent: { action: "query" }, nav: [{ op: "click", target: '[data-nav="pr-list"]', label: "목록" }], items: [], read: true };
      const r = await ctx.runPlan(plan, {});
      const ok = r.ok && r.read && r.read.kind === "list" && r.read.rows.length >= 2 && r.finalSignature.screen === "pr-list";
      return { ok, note: `read=${r.read && r.read.kind} 행=${r.read && r.read.rows.length} 화면=${r.finalSignature && r.finalSignature.screen}` };
    } },

  { id: "RP6", name: "삭제: 홈→목록 이동 → 행 삭제 → 확인",
    expect: "PR-2026-0041 행 사라짐, 화면=pr-list",
    run: async (ctx) => {
      await ctx.load();
      const plan = {
        intent: { action: "delete" }, nav: [{ op: "click", target: '[data-nav="pr-list"]', label: "목록" }], items: [],
        save: { op: "click", target: '.row-delete[data-pr="PR-2026-0041"]', irreversible: true, gate: { mode: "confirm" } },
        gate: { mode: "confirm" },
      };
      const r = await ctx.runPlan(plan, { commitSave: true });
      const stillThere = await ctx.visible('tr[data-pr="PR-2026-0041"]');
      const ok = r.ok && r.committed && stillThere === false && r.finalSignature.screen === "pr-list";
      return { ok, note: `삭제후존재=${stillThere} 화면=${r.finalSignature && r.finalSignature.screen}` };
    } },

  { id: "RP7", name: "수정: 홈→목록→상세→수정 이동 → 부서 변경 → 저장",
    expect: "화면=pr-detail, 부서=구매팀(diff 반영)",
    run: async (ctx) => {
      await ctx.load();
      const plan = {
        intent: { action: "update" },
        nav: [
          { op: "click", target: '[data-nav="pr-list"]', label: "목록" },
          { op: "click", target: '.row-detail[data-pr="PR-2026-0041"]', label: "상세" },
          { op: "click", target: "#edit-pr", label: "수정" },
        ],
        items: [{ op: "select", field_key: "#f-dept", label: "부서", value: "구매팀" }],
        save: { op: "click", target: "#save-btn", irreversible: true, gate: { mode: "confirm" } }, gate: { mode: "confirm" },
      };
      const r = await ctx.runPlan(plan, { commitSave: true });
      const dept = await ctx.text('[data-field="dept"]');
      const ok = r.ok && r.finalSignature.screen === "pr-detail" && dept === "구매팀";
      return { ok, note: `화면=${r.finalSignature && r.finalSignature.screen} 부서=${dept}` };
    } },

  { id: "RP8", name: "등록: 홈→폼 이동 → 채움 → 등록(채우고 등록)",
    expect: "nav 후 등록 완료, 요청번호 PR-2026-0042",
    run: async (ctx) => {
      await ctx.load(); // 홈에서 시작 — 에이전트가 폼으로 이동
      const plan = {
        intent: { action: "create" },
        nav: [{ op: "click", target: '[data-nav="pr-form"]', label: "등록" }],
        items: [
          { op: "fill", field_key: "#f-title", label: "요청제목", value: "비품" },
          { op: "select", field_key: "#f-dept", label: "부서", value: "총무팀" },
          { op: "fill", field_key: "#f-due", label: "납기일", value: "2026-07-15" },
          { op: "searchSelect", field_key: '.item-search[data-row="0"]', label: "품목", query: "볼펜", row: 0, needs_resolution: true },
          { op: "fill", field_key: '[data-line-qty="0"]', label: "수량", value: 5, row: 0 },
        ],
        save: { op: "click", target: "#save-btn", irreversible: true, gate: { mode: "confirm" } }, gate: { mode: "confirm" },
      };
      const r = await ctx.runPlan(plan, { commitSave: true });
      const ok = r.ok && r.committed && r.prNo === "PR-2026-0042" && r.finalSignature.screen === "result";
      return { ok, note: `번호=${r.prNo} 화면=${r.finalSignature && r.finalSignature.screen}` };
    } },

  { id: "RP9", name: "매핑: 메뉴 읽기전용 순회 → 화면·폼 수집",
    expect: "home/pr-list/pr-form 관찰, pr-form 폼스키마 3필드 + 라인그리드",
    run: async (ctx) => {
      await ctx.load(); // 홈에서 시작
      const obs = await ctx.mapWalk(['[data-nav="pr-list"]', '[data-nav="pr-form"]']);
      const ids = obs.map((o) => o.id);
      const form = obs.find((o) => o.id === "pr-form");
      const ok = ids.includes("home") && ids.includes("pr-list") && ids.includes("pr-form")
        && form && form.form_context && (form.form_context.fields || []).length === 3 && !!form.form_context.line_grid;
      return { ok, note: `ids=${ids.join(",")} 폼필드=${form && form.form_context && form.form_context.fields.length}` };
    } },
];

export default {
  id: "action-runplan",
  title: "PlanExecutor — fill-plan 실행",
  kind: "browser",
  description: "실제 Chromium + 목업에서 서버 모양의 fill-plan 을 UDCA.runPlan 으로 실행 → 채움 순서·검색선택 해소(자동/지정)·저장 게이트(채우기만 vs 채우고 등록)·실패 중단 검증.",
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
