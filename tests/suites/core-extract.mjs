// 스위트: 핵심 어댑터 추출 (browser) — 실제 Chromium + demo.html, recipe 없이 전체 파이프라인.
// recipe-schema 가 '레시피 기능'을 본다면, 이 스위트는 그 아래의 '어댑터가 뽑은 데이터 자체'가
// 맞는지 본다: table 라벨/단위/타입 · dataLayer(MAIN) 전체 50행 · 가상스크롤 최댓값 ·
// dom-structure 인사카드 · 병합 dedup · 차트(MAIN) · text 폴백.
//
// 기대값 출처는 server/web/demo.html:
//   요약표(html <table>): 공종 / 계약금액 합계(백만원) / 현장수, 4행(주택·토목·플랜트·건축)
//   그리드(window.GRID): 50행, contract = 50000 + i*1000 → 최댓값 현장-50 = 100,000
//   인사카드(.empcard): 성명=박지연 / 부서=토목사업부 / 연락처=010-9876-5432
//   차트(Chart.instances): "공종별 계약금액 합계"(bar) / "월별 누적 기성 추이"(line)
import { openDemo } from "../lib/browser.mjs";

// ── 결과(r) 판정 헬퍼 ─────────────────────────────────────────────────
const gridTable = (r) => (r.tables || []).find((t) => (t.rows || []).length === 50);
const summaryTable = (r) =>
  (r.tables || []).find((t) => (t.rows || []).length === 4 && (t.columns || []).length === 3);
const col = (t, label) => (t && (t.columns || []).find((c) => (c.label || "") === label)) || null;

const hasPM = (r) => (r.sections || []).some((s) => s.kind === "card" && /담당 PM/.test(s.title || ""));
const pmField = (r, label) => {
  const pm = (r.sections || []).find((s) => s.kind === "card" && /담당 PM/.test(s.title || ""));
  const f = pm && (pm.fields || []).find((x) => (x.label || "").includes(label));
  return f ? f.value : undefined;
};
const textOf = (r) => (r.sections || []).filter((s) => s.kind === "text").map((s) => s.text || "").join(" ");

// 모든 케이스는 recipe 없이(전체 추출) 동일한 결과 r 을 본다. needs:"chart" 면 Chart 미로드 시 SKIP.
const CASES = [
  { id: "C1", name: "table 어댑터: 요약표 라벨/단위/숫자타입",
    expect: "컬럼 공종·'계약금액 합계'(단위 백만원, number)·현장수, 플랜트=988,000",
    assert: (r) => {
      const t = summaryTable(r);
      if (!t) return false;
      const amount = col(t, "계약금액 합계");
      return !!col(t, "공종") && !!col(t, "현장수")
        && amount && amount.unit === "백만원" && amount.type === "number"
        && t.rows[2][amount.key] === 988000; // 플랜트 행
    } },

  { id: "C2", name: "dataLayer(MAIN): 가상스크롤 전체 50행 + 컬럼정의 라벨",
    expect: "그리드 50행, 라벨 현장명/공종/계약금액/누적기성액, 계약금액 단위 백만원·number",
    assert: (r) => {
      const g = gridTable(r);
      if (!g) return false;
      const contract = col(g, "계약금액");
      return !!col(g, "현장명") && !!col(g, "공종") && !!col(g, "누적기성액")
        && contract && contract.unit === "백만원" && contract.type === "number"
        && g.rows.length === 50;
    } },

  { id: "C3", name: "가상스크롤 핵심: 화면 밖 최댓값 행(MAIN 없으면 못 찾음)",
    expect: "계약금액 최댓값 = 100,000 (현장-50)",
    assert: (r) => {
      const g = gridTable(r);
      const c = col(g, "계약금액");
      const s = col(g, "현장명");
      if (!g || !c || !s) return false;
      const top = g.rows.reduce((a, b) => (b[c.key] > a[c.key] ? b : a));
      return top[c.key] === 100000 && top[s.key] === "현장-50";
    } },

  { id: "C4", name: "dom-structure: 인사카드 라벨-값 매핑",
    expect: "담당 PM 카드, 성명=박지연 / 부서=토목사업부 / 연락처=010-9876-5432",
    assert: (r) => hasPM(r)
      && pmField(r, "성명") === "박지연"
      && pmField(r, "부서") === "토목사업부"
      && pmField(r, "연락처") === "010-9876-5432" },

  { id: "C5", name: "병합 dedup: 보이는-행 ISO 그리드를 MAIN 50행에 흡수",
    expect: "10행 이상 표는 정확히 1개(50행) — 중복 그리드 없음",
    assert: (r) => {
      const big = (r.tables || []).filter((t) => (t.rows || []).length >= 10);
      return big.length === 1 && big[0].rows.length === 50;
    } },

  { id: "C6", name: "차트(MAIN Chart.instances): 제목/라벨/시리즈 값", needs: "chart",
    expect: "차트 2개, 공종별 bar [주택,토목,플랜트,건축]=[912000,975000,988000,900000]",
    assert: (r) => {
      if ((r.charts || []).length !== 2) return false;
      const bar = r.charts.find((c) => /공종별 계약금액/.test(c.title || ""));
      const line = r.charts.find((c) => /월별 누적 기성/.test(c.title || ""));
      if (!bar || !line) return false;
      const d = (bar.series[0] || {}).data || [];
      return bar.type === "bar" && line.type === "line"
        && bar.labels.join(",") === "주택,토목,플랜트,건축"
        && d[2] === 988000;
    } },

  { id: "C7", name: "text 폴백: 구조화 안 된 보이는 텍스트 캡처",
    expect: "페이지 제목 '현장 관리 대시보드' 가 text 섹션에 포함",
    assert: (r) => /현장 관리 대시보드/.test(textOf(r)) },
];

export default {
  id: "core-extract",
  title: "핵심 어댑터 추출",
  kind: "browser",
  description: "실제 Chromium + demo.html 에서 recipe 없이 전체 추출 → table 라벨/단위/타입·dataLayer 전체 50행·가상스크롤 최댓값·인사카드·병합 dedup·차트·text 폴백의 '데이터 정확성' 검증.",
  cases: CASES,
  async setup() { return await openDemo(); },
  async teardown(ctx) { if (ctx) await ctx.close(); },
  async run(testCase, ctx) {
    if (testCase.needs === "chart" && !ctx.chartOk) return { skip: true, note: "Chart.js 미로드(네트워크)" };
    const r = await ctx.extract(null);
    const ok = !!testCase.assert(r);
    return {
      ok,
      note: ok
        ? `tables=${r.tables.length} · charts=${r.charts.length} · source=${r.source}`
        : `FAIL — tables=${r.tables.length} · sections=${r.sections.length} · charts=${r.charts.length} · source=${r.source}`,
    };
  },
};
