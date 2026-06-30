// 구매시스템 목업 — 순수 JS(빌드 도구 없이). 익스텐션을 전혀 모르는 "레거시 업무화면" 역할.
//
// 설계 의도(§12 의도적 난이도):
//  - 딥링크 없음: 메뉴/행 클릭으로 #content 만 교체. "도착"은 URL 이 아니라 data-screen 시그니처로 판정.
//  - controlled input: 화면에 보이는 값이 아니라 *내부 모델(state)* 이 원천. 정확한 input/change 이벤트가
//    와야 모델이 바뀐다 → 단순 `input.value=` 주입은 저장 시 빈 값 → "안전 입력"만 통과.
//  - 품목은 타이핑 불가, 검색 팝업으로만("볼펜"→3종) → 후보 고르기(HITL).
//  - 금액·합계·단가는 readonly 자동계산.
//
// 화면(§12): 홈 / 구매요청 목록(상세·삭제·신규등록) / 등록 폼 / 상세(+수정).

// ── 품목 마스터(검색 결과의 원천) ──────────────────────────────────────
const ITEM_MASTER = [
  { code: "P-1001", name: "볼펜(흑)", price: 500 },
  { code: "P-1002", name: "볼펜(청)", price: 500 },
  { code: "P-1003", name: "볼펜(적)", price: 600 },
  { code: "P-2001", name: "스테이플러", price: 3500 },
  { code: "P-3001", name: "A4용지(박스)", price: 24000 },
  { code: "P-3002", name: "포스트잇", price: 1200 },
];
const DEPTS = ["총무팀", "구매팀", "연구개발팀"];

// ── 내부 모델(원천). 화면은 이 모델을 비추는 거울일 뿐. ─────────────────
const state = {
  screen: "home",
  mode: "create", // 폼 모드: create | edit
  form: { title: "", dept: "", due: "" },
  lines: [], // { code, name, price, qty }
  editingNo: null, // 수정/상세 대상 요청번호
  errors: [],
  saved: null, // 마지막 저장 결과 { prNo, ... }
  pending: null, // 확인 모달 대기 동작 { type: "save"|"delete", prNo? }
  // 목록 레코드(조회·수정·삭제 대상). 등록 시 여기에 누적된다.
  records: [
    { prNo: "PR-2026-0040", title: "3월 사무용품", dept: "총무팀", due: "2026-03-10",
      lines: [{ code: "P-1001", name: "볼펜(흑)", price: 500, qty: 20 }], status: "승인" },
    { prNo: "PR-2026-0041", title: "연구소 비품", dept: "연구개발팀", due: "2026-04-02",
      lines: [{ code: "P-2001", name: "스테이플러", price: 3500, qty: 5 }], status: "작성중" },
  ],
};
let prSeq = 42; // 다음 채번. 첫 등록 = PR-2026-0042

const content = document.getElementById("content");

// ── 라우팅(딥링크 없음): 화면 전환 = #content 교체 + data-screen 갱신 ────
function navigate(screen) {
  state.screen = screen;
  state.errors = [];
  render();
}

function render() {
  content.setAttribute("data-screen", state.screen);
  if (state.screen === "home") return renderHome();
  if (state.screen === "pr-list") return renderList();
  if (state.screen === "pr-form" || state.screen === "pr-edit") return renderForm();
  if (state.screen === "pr-detail") return renderDetail();
  if (state.screen === "result") return renderResult();
}

function renderHome() {
  content.innerHTML = `
    <h1 data-title="홈">구매시스템 홈</h1>
    <p>좌측 메뉴에서 <b>구매 &gt; 구매요청 &gt; 목록/등록(신규)</b> 으로 이동합니다.</p>`;
}

// ── 목록(조회·삭제·신규등록 진입) ───────────────────────────────────────
function renderList() {
  const rows = state.records
    .map(
      (r) => `
    <tr data-pr="${esc(r.prNo)}">
      <td>${esc(r.prNo)}</td><td>${esc(r.title)}</td><td>${esc(r.dept)}</td>
      <td>${recordTotal(r)}</td><td>${esc(r.status)}</td>
      <td><button type="button" class="row-detail" data-pr="${esc(r.prNo)}">상세</button>
          <button type="button" class="row-delete" data-pr="${esc(r.prNo)}">삭제</button></td>
    </tr>`
    )
    .join("");
  content.innerHTML = `
    <h1 data-title="구매요청 목록">구매요청 목록</h1>
    <div class="toolbar"><button data-nav="pr-form" id="new-pr">+ 신규등록</button></div>
    <table class="lines" id="pr-table">
      <thead><tr><th>요청번호</th><th>제목</th><th>부서</th><th>합계</th><th>상태</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">등록된 구매요청이 없습니다.</td></tr>'}</tbody>
    </table>`;
}

// ── 상세(읽기 전용 조회 + 수정 진입) ────────────────────────────────────
function renderDetail() {
  const r = state.records.find((x) => x.prNo === state.editingNo);
  if (!r) { content.innerHTML = `<h1 data-title="상세">레코드를 찾을 수 없습니다.</h1>`; return; }
  const lineRows = r.lines
    .map((l) => `<tr><td>${esc(l.name)}</td><td>${l.qty}</td><td>${l.price}</td><td>${l.qty * l.price}</td></tr>`)
    .join("");
  content.innerHTML = `
    <h1 data-title="구매요청 상세">구매요청 상세</h1>
    <table class="lines detail-head"><tbody>
      <tr><th>요청번호</th><td data-field="prNo">${esc(r.prNo)}</td></tr>
      <tr><th>요청제목</th><td data-field="title">${esc(r.title)}</td></tr>
      <tr><th>부서</th><td data-field="dept">${esc(r.dept)}</td></tr>
      <tr><th>납기일</th><td data-field="due">${esc(r.due)}</td></tr>
      <tr><th>상태</th><td data-field="status">${esc(r.status)}</td></tr>
    </tbody></table>
    <h2 style="font-size:16px;">품목</h2>
    <table class="lines"><thead><tr><th>품목</th><th>수량</th><th>단가</th><th>금액</th></tr></thead>
      <tbody>${lineRows}</tbody></table>
    <div class="total">합계: <span id="detail-total">${recordTotal(r)}</span> 원</div>
    <div class="toolbar"><button id="edit-pr" data-pr="${esc(r.prNo)}">수정</button>
      <button data-nav="pr-list">목록으로</button></div>`;
}

// ── 등록/수정 폼 (공용) ─────────────────────────────────────────────────
function renderForm() {
  const editing = state.screen === "pr-edit";
  if (!state.lines.length) addLine(false); // 폼 진입 시 빈 라인 1개(편집은 prefill 됨)
  const opts = ['<option value="">선택</option>']
    .concat(DEPTS.map((d) => `<option value="${d}">${d}</option>`))
    .join("");
  content.innerHTML = `
    <h1 data-title="${editing ? "구매요청 수정" : "구매요청 등록"}">구매요청 ${editing ? "수정" : "등록"}</h1>
    <div class="field">
      <label for="f-title">요청제목 <span class="req">*</span></label>
      <input id="f-title" name="title" type="text" required value="${esc(state.form.title)}" />
      <div class="echo" data-echo="title"></div>
    </div>
    <div class="field">
      <label for="f-dept">부서 <span class="req">*</span></label>
      <select id="f-dept" name="dept" required>${opts}</select>
      <div class="echo" data-echo="dept"></div>
    </div>
    <div class="field">
      <label for="f-due">납기일 <span class="req">*</span></label>
      <input id="f-due" name="due" type="date" required value="${esc(state.form.due)}" />
      <div class="echo" data-echo="due"></div>
    </div>

    <h2 style="font-size:16px;">요청 품목</h2>
    <table class="lines" id="line-grid">
      <thead><tr><th style="width:46%">품목 <span class="req">*</span></th>
        <th style="width:14%">수량</th><th style="width:18%">단가</th>
        <th style="width:18%">금액</th><th></th></tr></thead>
      <tbody id="line-body"></tbody>
    </table>
    <div class="toolbar"><button id="add-line" type="button">행추가</button></div>
    <div class="total">합계: <span id="grand-total">0</span> 원</div>

    <div class="errors" id="errors"></div>
    <div class="toolbar"><button id="save-btn" type="button" class="primary">저장</button>
      ${editing ? '<button data-nav="pr-list" type="button">취소</button>' : ""}</div>`;

  document.getElementById("f-dept").value = state.form.dept; // select 는 별도 반영
  renderLines();
  sync();
}

function renderLines() {
  const body = document.getElementById("line-body");
  if (!body) return;
  body.innerHTML = state.lines
    .map(
      (ln, i) => `
    <tr data-row="${i}">
      <td><div class="itemcell">
        <input class="name" type="text" readonly placeholder="검색으로 선택"
               value="${esc(ln.name)}" data-line-name="${i}" />
        <button type="button" class="item-search" data-row="${i}">검색</button>
      </div></td>
      <td><input type="number" min="0" class="qty" data-line-qty="${i}" value="${ln.qty || 0}" /></td>
      <td><input type="text" readonly class="price" data-line-price="${i}" value="${ln.price || 0}" /></td>
      <td><input type="text" readonly class="amount" data-line-amount="${i}" value="${(ln.qty || 0) * (ln.price || 0)}" /></td>
      <td><button type="button" class="del-line" data-row="${i}">삭제</button></td>
    </tr>`
    )
    .join("");
}

function renderResult() {
  const s = state.saved || {};
  content.innerHTML = `
    <h1 data-title="등록 완료">등록 완료</h1>
    <div class="result-banner">구매요청이 등록되었습니다. 요청번호 <b id="pr-no">${esc(s.prNo || "")}</b>
      <div class="muted">제목: ${esc(s.title || "")} · 부서: ${esc(s.dept || "")} · 품목 ${s.lineCount || 0}건 · 합계 ${s.total || 0}원</div>
    </div>
    <div class="toolbar"><button data-nav="pr-list">목록으로</button></div>`;
}

// ── 모델 → 화면 동기화(컨트롤드 인풋의 본질: 모델이 원천) ────────────────
function sync() {
  document.querySelectorAll("[data-echo]").forEach((el) => {
    const k = el.getAttribute("data-echo");
    const v = state.form[k];
    el.textContent = "모델값: " + (v == null || v === "" ? "(빈값)" : v);
  });
  recalcLines();
}

function recalcLines() {
  let total = 0;
  state.lines.forEach((ln, i) => {
    const amt = (Number(ln.qty) || 0) * (Number(ln.price) || 0);
    total += amt;
    setVal(`[data-line-price="${i}"]`, ln.price || 0);
    setVal(`[data-line-amount="${i}"]`, amt);
    setVal(`[data-line-name="${i}"]`, ln.name || "");
  });
  const gt = document.getElementById("grand-total");
  if (gt) gt.textContent = String(total);
}

function setVal(sel, v) {
  const el = document.querySelector(sel);
  if (el && document.activeElement !== el) el.value = String(v);
}

function addLine(doRender = true) {
  state.lines.push({ code: "", name: "", price: 0, qty: 0 });
  if (doRender) { renderLines(); sync(); }
}

function recordTotal(r) {
  return (r.lines || []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
}

// ── 품목 검색 팝업 ──────────────────────────────────────────────────────
let searchRow = -1;
const itemModal = document.getElementById("item-modal");
const itemResults = document.getElementById("item-results");

function openItemSearch(row) {
  searchRow = row;
  document.getElementById("item-q").value = "";
  itemResults.innerHTML = "";
  itemModal.hidden = false;
  document.getElementById("item-q").focus();
}
function runItemSearch() {
  const q = (document.getElementById("item-q").value || "").trim();
  const hits = q ? ITEM_MASTER.filter((it) => it.name.includes(q)) : [];
  itemResults.innerHTML = hits.length
    ? hits
        .map(
          (it) => `<li><button type="button" class="item-pick" data-code="${it.code}">
            ${it.name} <span class="muted">· ${it.code} · ${it.price}원</span></button></li>`
        )
        .join("")
    : `<li class="muted" style="padding:8px;">검색 결과 없음</li>`;
}
function pickItem(code) {
  const it = ITEM_MASTER.find((x) => x.code === code);
  if (it && state.lines[searchRow]) {
    state.lines[searchRow] = { code: it.code, name: it.name, price: it.price, qty: state.lines[searchRow].qty || 0 };
  }
  itemModal.hidden = true;
  renderLines();
  sync();
}

// ── 저장/삭제 → 검증 → 확인모달 → 결과(되돌릴 수 없는 행동) ──────────────
const confirmModal = document.getElementById("confirm-modal");
const confirmMsg = document.getElementById("confirm-msg");

function validate() {
  const e = [];
  if (!state.form.title.trim()) e.push("요청제목은 필수입니다.");
  if (!state.form.dept) e.push("부서는 필수입니다.");
  if (!state.form.due) e.push("납기일은 필수입니다.");
  if (!state.lines.filter((l) => l.code && Number(l.qty) > 0).length)
    e.push("품목을 1건 이상(수량 1 이상) 입력해야 합니다.");
  state.errors = e;
  return e.length === 0;
}

function trySave() {
  const box = document.getElementById("errors");
  if (!validate()) {
    if (box) box.innerHTML = "<ul>" + state.errors.map((x) => `<li>${esc(x)}</li>`).join("") + "</ul>";
    return;
  }
  if (box) box.innerHTML = "";
  state.pending = { type: "save" };
  if (confirmMsg) confirmMsg.textContent = state.screen === "pr-edit"
    ? "수정한 내용으로 저장하시겠습니까?" : "입력한 내용으로 구매요청을 등록하시겠습니까?";
  confirmModal.hidden = false; // 사람 확인 요구(HITL 끝단)
}

function askDelete(prNo) {
  state.pending = { type: "delete", prNo };
  if (confirmMsg) confirmMsg.textContent = `요청 ${prNo} 을(를) 삭제하시겠습니까? 되돌릴 수 없습니다.`;
  confirmModal.hidden = false;
}

// 확인 모달의 [확인] — 대기 중인 동작에 따라 분기.
function commitPending() {
  const p = state.pending;
  confirmModal.hidden = true;
  state.pending = null;
  if (!p) return;
  if (p.type === "save") return commitSave();
  if (p.type === "delete") return commitDelete(p.prNo);
}

function commitSave() {
  const total = state.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const cleanLines = state.lines.filter((l) => l.code).map((l) => ({ ...l }));
  const lineCount = cleanLines.length;
  if (state.screen === "pr-edit" && state.editingNo) {
    // 수정: 기존 레코드 갱신 → 상세로
    const r = state.records.find((x) => x.prNo === state.editingNo);
    if (r) { r.title = state.form.title; r.dept = state.form.dept; r.due = state.form.due; r.lines = cleanLines; }
    state.saved = { prNo: state.editingNo, title: state.form.title, dept: state.form.dept, total, lineCount };
    navigate("pr-detail");
    return;
  }
  // 등록: 채번 후 레코드 추가 → 결과 화면
  const prNo = "PR-2026-" + String(prSeq++).padStart(4, "0");
  state.records.push({ prNo, title: state.form.title, dept: state.form.dept, due: state.form.due, lines: cleanLines, status: "작성중" });
  state.saved = { prNo, title: state.form.title, dept: state.form.dept, total, lineCount };
  navigate("result");
}

function commitDelete(prNo) {
  state.records = state.records.filter((r) => r.prNo !== prNo);
  navigate("pr-list");
}

// 상세/수정 진입: 레코드를 폼 모델로 적재.
function openDetail(prNo) { state.editingNo = prNo; navigate("pr-detail"); }
function openEdit(prNo) {
  const r = state.records.find((x) => x.prNo === prNo);
  if (!r) return;
  state.editingNo = prNo;
  state.mode = "edit";
  state.form = { title: r.title, dept: r.dept, due: r.due };
  state.lines = r.lines.map((l) => ({ ...l }));
  navigate("pr-edit");
}
function newForm() {
  state.mode = "create";
  state.editingNo = null;
  state.form = { title: "", dept: "", due: "" };
  state.lines = [];
  navigate("pr-form");
}

// ── 이벤트 위임(컨트롤드 인풋: 정확한 input/change 에만 모델 반영) ─────────
content.addEventListener("input", onFieldChange);
content.addEventListener("change", onFieldChange);
function onFieldChange(e) {
  const t = e.target;
  if (!t) return;
  if (t.id === "f-title") state.form.title = t.value;
  else if (t.id === "f-dept") state.form.dept = t.value;
  else if (t.id === "f-due") state.form.due = t.value;
  else if (t.hasAttribute("data-line-qty")) {
    const i = Number(t.getAttribute("data-line-qty"));
    if (state.lines[i]) state.lines[i].qty = Number(t.value) || 0;
  } else return;
  sync();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest(
    "[data-nav], #add-line, .item-search, .item-pick, #item-search-btn, #item-cancel, " +
    ".del-line, #save-btn, #confirm-ok, #confirm-cancel, .row-detail, .row-delete, #edit-pr"
  );
  if (!t) return;
  if (t.hasAttribute("data-nav")) {
    e.preventDefault();
    const nav = t.getAttribute("data-nav");
    if (nav === "pr-form") newForm(); // 신규 등록은 폼 모델을 비우고 진입
    else navigate(nav);
  }
  else if (t.id === "add-line") addLine();
  else if (t.classList.contains("item-search")) openItemSearch(Number(t.getAttribute("data-row")));
  else if (t.id === "item-search-btn") runItemSearch();
  else if (t.classList.contains("item-pick")) pickItem(t.getAttribute("data-code"));
  else if (t.id === "item-cancel") itemModal.hidden = true;
  else if (t.classList.contains("del-line")) { state.lines.splice(Number(t.getAttribute("data-row")), 1); renderLines(); sync(); }
  else if (t.classList.contains("row-detail")) openDetail(t.getAttribute("data-pr"));
  else if (t.classList.contains("row-delete")) askDelete(t.getAttribute("data-pr"));
  else if (t.id === "edit-pr") openEdit(t.getAttribute("data-pr"));
  else if (t.id === "save-btn") trySave();
  else if (t.id === "confirm-ok") commitPending();
  else if (t.id === "confirm-cancel") { confirmModal.hidden = true; state.pending = null; }
});

document.getElementById("item-q").addEventListener("keydown", (e) => { if (e.key === "Enter") runItemSearch(); });

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

render(); // 첫 화면 = 홈
