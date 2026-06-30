// 목업 하니스 — 실제 Chromium 에서 PoC 목업(구매시스템)을 열고, 익스텐션 액션층(content/action/*)+
// base.js 저수준 유틸을 주입해 FormContext 추출·안전입력·검색선택·도착감지를 재현한다.
// browser 유형 액션 스위트의 setup() 에서 openMock() 을 호출해 ctx 로 쓴다.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const read = (p) => readFileSync(ROOT + p, "utf8");
const MOCK_URL = pathToFileURL(ROOT + "/server/web/mock/index.html").href;

// 주입 순서: base.js(UDC 저수준) → screen-id → form-extract → actions(UDCA).
const SCRIPTS = [
  "/extension/content/base.js",
  "/extension/content/action/screen-id.js",
  "/extension/content/action/form-extract.js",
  "/extension/content/action/actions.js",
  "/extension/content/action/run-plan.js",
];

async function inject(page) {
  for (const p of SCRIPTS) await page.addScriptTag({ content: read(p) });
}

// ctx: { browser, page, errors, load, extractForm, exec, signature, echo, text, val, visible, setRaw, close }
export async function openMock() {
  // PWHEADED=1 이면 실제 브라우저 창을 띄워 액션을 눈으로 볼 수 있다(직접 확인용).
  // PWSLOW 로 동작 사이 지연(ms) 조절(기본: 헤디드일 때 250ms). 예) PWHEADED=1 PWSLOW=600 node tests/run.mjs action-primitives
  const headed = !!process.env.PWHEADED;
  const slowMo = process.env.PWSLOW ? Number(process.env.PWSLOW) : (headed ? 250 : 0);
  const browser = await chromium.launch({ headless: !headed, slowMo });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  // 화면 로드 + 액션층 주입. nav 가 주어지면 그 메뉴로 이동(도착까지 대기).
  const load = async (nav) => {
    await page.goto(MOCK_URL, { waitUntil: "load" });
    await inject(page);
    if (nav) {
      await page.click(`[data-nav="${nav}"]`);
      if (nav === "pr-form") await page.waitForSelector("#save-btn");
    }
  };

  return {
    browser, page, errors, load,
    extractForm: () => page.evaluate(() => UDCA.extractForm(document.getElementById("content"))),
    exec: (action) => page.evaluate(async (a) => await UDCA.exec(a), action),
    runPlan: (plan, opts) => page.evaluate(async ([p, o]) => await UDCA.runPlan(p, o || {}), [plan, opts || {}]),
    mapWalk: (targets) => page.evaluate(async (t) => await UDCA.mapWalk(t), targets),
    signature: () => page.evaluate(() => UDCA.signature(document)),
    // 모델 거울(echo) — controlled input 의 내부 모델 상태를 비춘다("모델값: ...").
    echo: (key) => page.evaluate((k) => { const el = document.querySelector(`[data-echo="${k}"]`); return el ? el.textContent : null; }, key),
    text: (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? (el.textContent || "").trim() : null; }, sel),
    val: (sel) => page.evaluate((s) => { const el = document.querySelector(s); return el ? el.value : null; }, sel),
    visible: (sel) => page.evaluate((s) => { const el = document.querySelector(s); return !!el && !el.hidden; }, sel),
    // 위험한(잘못된) 입력 흉내: 이벤트 없이 .value 만 주입 → controlled input 모델은 안 바뀜.
    setRaw: (sel, v) => page.evaluate(([s, vv]) => { const el = document.querySelector(s); if (el) el.value = vv; }, [sel, v]),
    close: () => browser.close(),
  };
}
