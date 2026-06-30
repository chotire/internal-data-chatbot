// ActionExecutor — 기본 동작(primitive) 실행: 안전입력·select·click·검색선택·도착대기·되읽기.
// "무엇을" 할지(어느 칸에 무슨 값)는 에이전트(Planner)가 정하고, 여기서는 시키는 동작을 수행만 한다.
//
// 안전 입력의 핵심(§1·glossary controlled input): 단순 `el.value=` 는 React/Vue 등의 *내부 모델*을
// 바꾸지 못해 저장 시 빈 값이 된다. native value setter 로 값을 넣고 input/change 를 디스패치해야
// 페이지가 "사용자가 친 것"으로 받아들여 모델을 갱신한다.

globalThis.UDCA = globalThis.UDCA || {};

// controlled input 을 뚫는 안전 값 주입.
UDCA.setNativeValue = function (el, value) {
  const proto = (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) ? HTMLTextAreaElement.prototype
    : (typeof HTMLSelectElement !== "undefined" && el instanceof HTMLSelectElement) ? HTMLSelectElement.prototype
    : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, "value");
  const setter = desc && desc.set;
  const own = Object.getOwnPropertyDescriptor(el, "value");
  if (setter && (!own || own.set !== setter)) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
};

// 조회: 현재 화면을 읽어 구조화. 목록 표가 있으면 행을, 상세면 라벨-값을 돌려준다.
UDCA.readScreen = function (doc) {
  doc = doc || document;
  const sig = UDCA.signature ? UDCA.signature(doc) : {};
  const table = doc.querySelector("#pr-table");
  if (table) {
    const columns = [...table.querySelectorAll("thead th")].map((th) => (th.textContent || "").trim()).filter(Boolean);
    const rows = [...table.querySelectorAll("tbody tr")]
      .map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.textContent || "").replace(/\s+/g, " ").trim()))
      .filter((r) => r.length);
    return { screen: sig.screen, kind: "list", columns, rows };
  }
  const fields = [...doc.querySelectorAll("[data-field]")].map((el) => ({
    key: el.getAttribute("data-field"), value: (el.textContent || "").trim(),
  }));
  if (fields.length) return { screen: sig.screen, kind: "detail", fields };
  return { screen: sig.screen, kind: "unknown" };
};

// 현재 화면이 보는 값(되읽기). 검증·diff 확인용.
UDCA.readBack = function (sel, doc) {
  const el = (doc || document).querySelector(sel);
  if (!el) return null;
  if ("value" in el && el.value != null) return el.value;
  return (el.textContent || "").trim();
};

// 액션 1개 실행. action = { op, target?, value?, query?, pick? }. 반환: { ok, readBack?, candidates?, ... }.
UDCA.exec = async function (action, doc) {
  doc = doc || document;
  const q = (sel) => (sel ? doc.querySelector(sel) : null);
  try {
    switch (action.op) {
      case "fill": {
        const el = q(action.target);
        if (!el) return { ok: false, error: "대상 없음: " + action.target };
        UDCA.setNativeValue(el, String(action.value == null ? "" : action.value));
        return { ok: true, readBack: UDCA.readBack(action.target, doc) };
      }
      case "select": {
        const el = q(action.target);
        if (!el) return { ok: false, error: "대상 없음: " + action.target };
        UDCA.setNativeValue(el, String(action.value == null ? "" : action.value));
        return { ok: true, readBack: el.value };
      }
      case "click": {
        const el = q(action.target);
        if (!el) return { ok: false, error: "대상 없음: " + action.target };
        el.click();
        return { ok: true };
      }
      case "addRow": {
        const el = q(action.target || "#add-line");
        if (!el) return { ok: false, error: "행추가 버튼 없음" };
        el.click();
        return { ok: true };
      }
      case "searchSelect":
        return await searchSelect(action, doc);
      case "readBack":
        return { ok: true, readBack: UDCA.readBack(action.target, doc) };
      case "waitFor": {
        const r = await UDCA.waitForScreen((sig) => UDCA.matches(sig, action.value || {}), { doc });
        return { ok: r.ok, signature: r.signature };
      }
      default:
        return { ok: false, error: "알 수 없는 op: " + action.op };
    }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
};

// 검색팝업으로만 고르는 품목: 버튼 클릭→팝업, 질의 입력→후보 목록 반환.
//  - value(정식코드) 주어지면 그 후보를 고르고, pick(인덱스)면 그 위치를 고른다.
//  - 둘 다 없으면 후보만 돌려준다(모호 → HITL 후보 고르기). 팝업은 열린 채.
async function searchSelect(action, doc) {
  const btn = doc.querySelector(action.target);
  if (!btn) return { ok: false, error: "검색 버튼 없음: " + action.target };
  btn.click();
  const qbox = doc.querySelector("#item-q");
  if (!qbox) return { ok: false, error: "검색 입력 없음(팝업 미오픈)" };
  UDCA.setNativeValue(qbox, String(action.query || ""));
  const go = doc.querySelector("#item-search-btn");
  if (go) go.click();

  const candidates = [...doc.querySelectorAll("#item-results .item-pick")].map((b) => ({
    code: b.getAttribute("data-code"),
    text: (b.textContent || "").replace(/\s+/g, " ").trim(),
  }));

  if (action.value != null) {
    const hit = doc.querySelector('#item-results .item-pick[data-code="' + action.value + '"]');
    if (!hit) return { ok: false, candidates, error: "후보 중 해당 코드 없음: " + action.value };
    hit.click();
    return { ok: true, candidates, picked: action.value };
  }
  if (typeof action.pick === "number") {
    const list = doc.querySelectorAll("#item-results .item-pick");
    if (!list[action.pick]) return { ok: false, candidates, error: "후보 인덱스 범위 밖: " + action.pick };
    list[action.pick].click();
    return { ok: true, candidates, picked: candidates[action.pick] && candidates[action.pick].code };
  }
  return { ok: true, candidates, picked: null, hitl: true }; // 모호 → 후보 고르기 대기
}
