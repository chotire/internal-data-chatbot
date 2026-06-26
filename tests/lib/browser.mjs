// 브라우저 하니스 — 실제 Chromium 에서 demo.html 을 열고, content scripts(UDC.run) +
// background 의 readDataLayer/sameData 를 주입해 추출 파이프라인(ISOLATED+MAIN 병합)을 재현한다.
// browser 유형 스위트의 setup() 에서 openDemo() 를 호출해 ctx 로 쓴다.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const read = (p) => readFileSync(ROOT + p, "utf8");

// background.js 에서 자기완결 함수만 추출(executeScript 로 주입되는 것과 동일 소스)
function extractFn(src, name) {
  const start = src.indexOf("function " + name);
  if (start < 0) throw new Error("함수 없음: " + name);
  let depth = 0, begun = false;
  for (let j = src.indexOf("{", start); j < src.length; j++) {
    if (src[j] === "{") { depth++; begun = true; }
    else if (src[j] === "}") { depth--; if (begun && depth === 0) return src.slice(start, j + 1); }
  }
  throw new Error("함수 추출 실패: " + name);
}

function injectScripts() {
  const bg = read("/extension/background.js");
  return [
    read("/extension/content/base.js"),
    read("/extension/content/adapters/table.js"),
    read("/extension/content/adapters/dom-structure.js"),
    read("/extension/content/adapters/websquare.js"),
    extractFn(bg, "readDataLayer"),
    extractFn(bg, "sameData"),
    // background extractFromTab 의 병합을 재현
    `window.__fullExtract = function (recipe) {
       const iso = UDC.run(document, recipe, null);
       const eff = iso.appliedRecipe || null;
       const main = readDataLayer(eff && eff.dataLayer ? eff.dataLayer : null, eff && eff.scope ? eff.scope : null);
       const hasMain = (main.tables && main.tables.length) || (main.charts && main.charts.length);
       const tables = [...(main.tables || [])];
       for (const t of iso.tables || []) if (!tables.some((m) => sameData(t, m))) tables.push(t);
       const source = [hasMain ? "dataLayer" : null, iso.source !== "none" ? iso.source : null].filter(Boolean).join("+") || "none";
       return { source, tables, sections: iso.sections, charts: (main.charts && main.charts.length) ? main.charts : iso.charts };
     };`,
  ];
}

// 데모 페이지를 열고 추출 함수를 주입한 ctx 를 반환.
// ctx: { browser, page, chartOk, extract(recipe)->result, close() }
export async function openDemo() {
  const demoUrl = pathToFileURL(ROOT + "/server/web/demo.html").href;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(demoUrl, { waitUntil: "load" });
  await page.waitForFunction(() => !!(window.GRID && window.GRID.rows && window.GRID.rows.length === 50), null, { timeout: 8000 });
  let chartOk = false;
  try {
    await page.waitForFunction(() => !!(window.Chart && window.Chart.instances && Object.keys(window.Chart.instances).length >= 2), null, { timeout: 8000 });
    chartOk = true;
  } catch { chartOk = false; }
  for (const code of injectScripts()) await page.addScriptTag({ content: code });
  return {
    browser, page, chartOk, errors,
    extract: (recipe) => page.evaluate((r) => window.__fullExtract(r), recipe),
    close: () => browser.close(),
  };
}
