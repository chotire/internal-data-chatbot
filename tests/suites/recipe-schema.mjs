// 스위트: recipe 추출 파이프라인 (browser) — 실제 Chromium + demo.html.
// scope include/exclude · domWhen · mask/deny · MAIN world 그리드/차트 scope · 가시성 · 병합.
import { openDemo } from "../lib/browser.mjs";

// 판정 헬퍼 (extract 결과 r 에 대해)
const hasPM = (r) => (r.sections || []).some((s) => s.kind === "card" && /담당 PM/.test(s.title || ""));
const pmField = (r, label) => {
  const pm = (r.sections || []).find((s) => s.kind === "card" && /담당 PM/.test(s.title || ""));
  const f = pm && (pm.fields || []).find((x) => (x.label || "").includes(label));
  return f ? f.value : undefined;
};
const hasGrid50 = (r) => (r.tables || []).some((t) => (t.rows || []).length === 50);
const textOf = (r) => (r.sections || []).filter((s) => s.kind === "text").map((s) => s.text || "").join(" ");

// 각 케이스: recipe 를 넣고 fullExtract 결과로 assert. needs:"chart" 면 Chart 미로드 시 SKIP.
const CASES = [
  { id: "T0", name: "회귀: recipe 없음 → 전체 추출",
    expect: "그리드50+요약표, PM카드, source=dataLayer+table+domStructure(+text)",
    recipe: null,
    assert: (r, env) => /dataLayer/.test(r.source) && /table/.test(r.source) && /domStructure/.test(r.source)
      && r.tables.length >= 2 && hasGrid50(r) && hasPM(r) && (env.chartOk ? r.charts.length === 2 : true) },

  { id: "T1", name: "scope.include=['.empcard'] → 본문만(그리드·차트·요약표 제외)",
    expect: "PM만, tables=0, charts=0, recipe:inc, dataLayer 없음",
    recipe: { name: "inc", scope: { include: [".empcard"] } },
    assert: (r) => hasPM(r) && r.tables.length === 0 && r.charts.length === 0 && /recipe:inc/.test(r.source) && !/dataLayer/.test(r.source) },

  { id: "T2", name: "scope.exclude=['.empcard'] → PM 제외, 나머지 유지",
    expect: "PM 없음, 그리드50 유지",
    recipe: { name: "exc", scope: { exclude: [".empcard"] } },
    assert: (r) => !hasPM(r) && hasGrid50(r) },

  { id: "T3", name: "domWhen=#NOPE(불일치) → recipe 미적용(전체)",
    expect: "recipe 미표기, 그리드50 유지",
    recipe: { name: "dw", match: { domWhen: "#NOPE" }, scope: { include: [".empcard"] } },
    assert: (r) => !/recipe:/.test(r.source) && hasGrid50(r) },

  { id: "T4", name: "domWhen=.empcard(일치) → include 적용",
    expect: "tables=0, recipe:dw2",
    recipe: { name: "dw2", match: { domWhen: ".empcard" }, scope: { include: [".empcard"] } },
    assert: (r) => r.tables.length === 0 && /recipe:dw2/.test(r.source) },

  { id: "T5", name: "mask=['.v-tel'] → 연락처 가림",
    expect: "연락처=***, 성명=박지연",
    recipe: { name: "m", mask: [".v-tel"] },
    assert: (r) => pmField(r, "연락처") === "***" && pmField(r, "성명") === "박지연" },

  { id: "T6", name: "deny=['.empcard'] → 완전 제외",
    expect: "PM 없음, 그리드50 유지",
    recipe: { name: "d", deny: [".empcard"] },
    assert: (r) => !hasPM(r) && hasGrid50(r) },

  { id: "T7", name: "include + dataLayer 힌트 → 그리드 opt-in, 차트 제외",
    expect: "그리드50 포함, charts=0",
    recipe: { name: "dl", scope: { include: [".empcard"] }, dataLayer: { type: "global", path: "window.GRID" } },
    assert: (r) => hasGrid50(r) && r.charts.length === 0 },

  { id: "T8", name: "차트 scope: exclude 로 worktype 차트 제외(실제 canvas)",
    expect: "차트 2→1, 그리드 유지", needs: "chart",
    recipe: { name: "cx", scope: { exclude: ["#chart-worktype"] } },
    assert: (r) => r.charts.length === 1 && hasGrid50(r) },

  { id: "V1", name: "가시성: 숨은 설치배너 텍스트 미포함(실제 getComputedStyle)",
    expect: "text 폴백에 '익스텐션 미감지/감지됨' 없음",
    recipe: null,
    assert: (r) => !/익스텐션 미감지|익스텐션 감지됨/.test(textOf(r)) },
];

export default {
  id: "recipe-schema",
  title: "recipe 추출 파이프라인",
  kind: "browser",
  description: "실제 Chromium 에서 demo.html 에 content scripts+readDataLayer 주입 → scope/domWhen/mask/deny·그리드/차트 scope·가시성·병합 검증.",
  cases: CASES,
  async setup() { return await openDemo(); },
  async teardown(ctx) { if (ctx) await ctx.close(); },
  async run(testCase, ctx) {
    if (testCase.needs === "chart" && !ctx.chartOk) return { skip: true, note: "Chart.js 미로드(네트워크)" };
    const r = await ctx.extract(testCase.recipe);
    const ok = !!testCase.assert(r, { chartOk: ctx.chartOk });
    return { ok, note: ok ? `source=${r.source}` : `source=${r.source} · tables=${r.tables.length} · charts=${r.charts.length}` };
  },
};
