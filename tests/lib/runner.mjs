// 제너릭 테스트 러너 — 스위트들을 실행해 결과를 집계하고 RESULTS.md 를 작성한다.
//
// 스위트(suite) 계약 (tests/suites/*.mjs 가 default export):
//   {
//     id:    "recipe-schema",           // 고유 id
//     title: "recipe 추출 파이프라인",   // 표 제목
//     kind:  "browser" | "command" | "unit",  // 분류(표시용)
//     async setup() -> ctx,             // (선택) 1회 준비. 반환값이 run 에 전달됨
//     async teardown(ctx),              // (선택) 정리
//     cases: [ { id, name, expect, needs? } ],
//     async run(testCase, ctx) -> { ok:boolean, note?:string, skip?:boolean },
//   }
//
// 러너는 "어떻게 실행하는지" 를 모른다(스위트가 run 으로 캡슐화). 러너는 순회·집계·리포트만.

import { writeFileSync } from "node:fs";

const ICON = { pass: "✅ PASS", fail: "❌ FAIL", skip: "⊘ SKIP" };

export async function runAll(suites, { reportPath, title = "테스트 결과", env = {} } = {}) {
  const results = []; // { suite, rows:[{id,name,expect,status,note}], pass,fail,skip }

  for (const suite of suites) {
    const row = { suite, rows: [], pass: 0, fail: 0, skip: 0 };
    let ctx = null;
    try {
      ctx = suite.setup ? await suite.setup() : null;
    } catch (e) {
      // setup 실패 → 모든 케이스 FAIL 처리
      for (const c of suite.cases) row.rows.push({ ...c, status: ICON.fail, note: "setup 실패: " + short(e) });
      row.fail = suite.cases.length;
      results.push(row);
      continue;
    }
    for (const c of suite.cases) {
      try {
        const r = await suite.run(c, ctx);
        if (r && r.skip) { row.rows.push({ ...c, status: ICON.skip, note: r.note || "" }); row.skip++; }
        else if (r && r.ok) { row.rows.push({ ...c, status: ICON.pass, note: r.note || "" }); row.pass++; }
        else { row.rows.push({ ...c, status: ICON.fail, note: (r && r.note) || "" }); row.fail++; }
      } catch (e) {
        row.rows.push({ ...c, status: ICON.fail, note: "예외: " + short(e) });
        row.fail++;
      }
    }
    try { if (suite.teardown) await suite.teardown(ctx); } catch { /* noop */ }
    results.push(row);
  }

  const md = buildReport(results, { title, env });
  if (reportPath) writeFileSync(reportPath, md);
  const totals = sum(results);
  return { md, totals, results };
}

function sum(results) {
  return results.reduce((a, r) => ({ pass: a.pass + r.pass, fail: a.fail + r.fail, skip: a.skip + r.skip }), { pass: 0, fail: 0, skip: 0 });
}
const short = (e) => String(e && e.message ? e.message : e).replace(/\s+/g, " ").slice(0, 140);
const esc = (s) => String(s == null ? "" : s).replace(/\|/g, "/").replace(/\n/g, " ");

function buildReport(results, { title, env }) {
  const t = sum(results);
  const stamp = (env.now || "") + (env.runner ? ` · ${env.runner}` : "");
  const lines = [];
  lines.push(`# ${title}`, "");
  if (stamp) lines.push(`> ${stamp}`);
  lines.push(`> **전체: ${t.pass} PASS / ${t.fail} FAIL / ${t.skip} SKIP** (${t.pass + t.fail + t.skip} 케이스, ${results.length} 스위트)`, "");

  // 요약 표
  lines.push("## 요약", "", "| 스위트 | 유형 | PASS | FAIL | SKIP |", "|---|---|---:|---:|---:|");
  for (const r of results) lines.push(`| ${esc(r.suite.title)} | ${r.suite.kind || "-"} | ${r.pass} | ${r.fail} | ${r.skip} |`);
  lines.push("");

  // 스위트별 상세
  for (const r of results) {
    lines.push(`## ${esc(r.suite.title)}  \`${r.suite.id}\``);
    if (r.suite.description) lines.push("", esc(r.suite.description));
    lines.push("", "| # | 시나리오 | 기대 | 결과 | 비고 |", "|---|---|---|---|---|");
    for (const c of r.rows) lines.push(`| ${esc(c.id)} | ${esc(c.name)} | ${esc(c.expect)} | ${c.status} | ${esc(c.note)} |`);
    lines.push("");
  }
  lines.push("---", "재실행: `node tests/run.mjs` · 케이스 추가: `tests/README.md` 참고", "");
  return lines.join("\n");
}
