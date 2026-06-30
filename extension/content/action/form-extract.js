// FormExtractor — 화면의 *입력 컨트롤*을 표준 형식 FormContext 로 추출한다(ScreenContext 의 "쓰기판").
// "어떤 칸이 있는지"만 파악하고, 값을 채워 넣지는 않는다(채움은 actions.js). v0.2 어댑터(읽기)와 분리.

globalThis.UDCA = globalThis.UDCA || {};

UDCA.extractForm = function (root) {
  const doc = (root && root.ownerDocument) || document;
  root = root || doc.getElementById("content") || doc.querySelector("form") || doc.body;
  const sig = UDCA.signature ? UDCA.signature(doc) : {};
  const grid = root.querySelector("#line-grid, table.lines");

  // 최상위 폼 컨트롤(라인 그리드 안쪽 칸은 제외 — 그리드는 line_grid 로 따로 기술).
  const fields = [];
  root.querySelectorAll("input, select, textarea").forEach((el) => {
    if (grid && grid.contains(el)) return;
    if (globalThis.UDC && UDC.isVisible && !UDC.isVisible(el)) return; // 보이는 칸만(제품 전제)
    const f = describeControl(el);
    if (f) fields.push(f);
  });

  let line_grid = null;
  if (grid) {
    const columns = [...grid.querySelectorAll("thead th")]
      .map((th) => (th.textContent || "").replace(/\*/g, "").trim())
      .filter(Boolean);
    const add = root.querySelector("#add-line, [data-add-line]");
    line_grid = {
      key: handleOf(grid),
      columns,
      addRowBtn: add ? handleOf(add) : null,
      // 품목은 타이핑 불가, 검색 팝업으로만 → "검색 위젯" 존재 표시(정식 코드 찾기 대상).
      itemSearch: !!root.querySelector(".item-search, [data-item-search]"),
    };
  }

  const saveEl = root.querySelector("#save-btn, button[type=submit]");
  const save_button = saveEl ? { key: handleOf(saveEl), label: (saveEl.textContent || "").trim() } : null;

  return {
    screen_id: sig.screen || null,
    signature: sig,
    fields,
    line_grid,
    save_button,
  };
};

// 하나의 컨트롤 → FormField {key, label, role, required, options[], unit}
function describeControl(el) {
  const tag = el.tagName.toLowerCase();
  let role, options = [];
  if (tag === "select") { role = "select"; options = [...el.options].map((o) => o.value).filter((v) => v !== ""); }
  else if (el.readOnly || el.getAttribute("readonly") != null) role = "readonly";
  else if (el.type === "date") role = "date";
  else if (el.type === "number") role = "number";
  else role = "text";

  const rawLabel = labelFor(el);
  const lu = (globalThis.UDC && UDC.splitLabelUnit) ? UDC.splitLabelUnit(rawLabel || "") : { label: rawLabel, unit: null };
  const required = !!(el.required || el.getAttribute("aria-required") === "true" || hasReqMark(el));
  return { key: handleOf(el), label: (lu.label || rawLabel || null), role, required, options, unit: lu.unit || null };
}

// 안정적 핸들(셀렉터). id 우선, 없으면 name.
function handleOf(el) {
  if (el.id) return "#" + cssEscape(el.id);
  const name = el.getAttribute && el.getAttribute("name");
  if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]';
  return null;
}

// 라벨 텍스트: <label for=id> → .field 안 label → placeholder. 끝의 필수표시(*)는 떼어낸다.
function labelFor(el) {
  const doc = el.ownerDocument || document;
  let txt = null;
  if (el.id) {
    const lab = doc.querySelector('label[for="' + cssEscape(el.id) + '"]');
    if (lab) txt = lab.textContent;
  }
  if (!txt) {
    const field = el.closest(".field");
    const lab = field && field.querySelector("label");
    if (lab) txt = lab.textContent;
  }
  if (!txt && el.getAttribute) txt = el.getAttribute("placeholder");
  return txt ? txt.replace(/[*\s]+$/g, "").replace(/\s+/g, " ").trim() : null;
}

function hasReqMark(el) {
  const field = el.closest(".field");
  return !!(field && field.querySelector(".req"));
}

function cssEscape(s) {
  return (globalThis.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
