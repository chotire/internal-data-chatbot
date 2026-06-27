// 테스트 진입점 — 모든 스위트를 실행하고 tests/RESULTS.md 를 작성한다.
//
//   실행:        node tests/run.mjs
//   특정 스위트:  node tests/run.mjs recipe-schema server-recipe   (id 로 필터)
//
// 새 스위트 추가: tests/suites/<id>.mjs 를 만들어 default export 하고 아래 SUITES 에 등록.

import { runAll } from "./lib/runner.mjs";
import recipeSchema from "./suites/recipe-schema.mjs";
import serverRecipe from "./suites/server-recipe.mjs";
import serverStream from "./suites/server-stream.mjs";
import coreExtract from "./suites/core-extract.mjs";

const SUITES = [serverRecipe, serverStream, coreExtract, recipeSchema];

const filter = process.argv.slice(2);
const suites = filter.length ? SUITES.filter((s) => filter.includes(s.id)) : SUITES;
if (!suites.length) {
  console.error("실행할 스위트 없음. 사용 가능:", SUITES.map((s) => s.id).join(", "));
  process.exit(2);
}

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");
const now = new Date().toISOString().replace("T", " ").slice(0, 19) + " UTC";

const { md, totals } = await runAll(suites, {
  reportPath: ROOT + "/tests/RESULTS.md",
  title: "테스트 결과 — internal-data-chatbot",
  env: { now, runner: "node tests/run.mjs" },
});

console.log(md);
console.log(`\n== 전체: ${totals.pass} PASS / ${totals.fail} FAIL / ${totals.skip} SKIP ==`);
process.exit(totals.fail ? 1 : 0);
