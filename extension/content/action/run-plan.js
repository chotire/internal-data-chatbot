// PlanExecutor — 서버 두뇌가 만든 fill-plan 을 받아 페이지에서 순서대로 실행한다.
// 이 모듈이 "계획(서버) ↔ 동작(채널)"을 잇는 런타임 접점이다. 동작 자체는 actions.js 의 프리미티브,
// 여기서는 *순서·해소·게이트 처리*만 한다(오케스트레이션). 결정론 로직이라 단위/브라우저로 테스트 가능.

globalThis.UDCA = globalThis.UDCA || {};

// 매핑 모드 — 주어진 *메뉴 대상*만 차례로 눌러 각 화면의 시그니처+폼을 수집한다(읽기 전용).
// 변이 버튼(저장·삭제)은 인자로 받지 않으므로 절대 눌리지 않는다(§8 가드레일은 호출부+서버 denylist).
UDCA.mapWalk = async function (targets, opts) {
  opts = opts || {};
  const doc = opts.doc || document;
  // 대상 미지정 시: 페이지의 메뉴 링크([data-nav])를 자동 발견(읽기전용 — 변이 버튼은 포함 안 됨).
  if (!targets || !targets.length) {
    const seen = new Set();
    targets = [...doc.querySelectorAll("[data-nav]")]
      .map((el) => `[data-nav="${el.getAttribute("data-nav")}"]`)
      .filter((s) => (seen.has(s) ? false : seen.add(s)));
  }
  const obs = [captureObs(doc, null, null)]; // 시작(현재) 화면 먼저
  for (const target of targets || []) {
    const from = UDCA.signature ? UDCA.signature(doc).screen : null;
    const r = await UDCA.exec({ op: "click", target }, doc);
    if (!r.ok) { obs.push({ error: r.error, via_target: target, from_id: from }); continue; }
    obs.push(captureObs(doc, target, from));
  }
  return obs;
};

function captureObs(doc, via, from) {
  const sig = UDCA.signature ? UDCA.signature(doc) : {};
  const root = doc.getElementById ? doc.getElementById("content") : null;
  const form = UDCA.extractForm ? UDCA.extractForm(root) : null;
  return { id: sig.screen, title: sig.title, signature: sig, form_context: form, via_target: via, from_id: from };
}

// fill-plan 항목 → 액션 프리미티브 입력으로 변환.
UDCA.itemToAction = function (item) {
  switch (item.op) {
    case "fill": return { op: "fill", target: item.field_key, value: item.value };
    case "select": return { op: "select", target: item.field_key, value: item.value };
    case "addRow": return { op: "addRow", target: item.field_key };
    // value 가 있으면(메모리/지정 해소된 정식코드) 그 후보를 바로 고른다. 없으면 후보만 받는다(HITL).
    case "searchSelect": return { op: "searchSelect", target: item.field_key, query: item.query, value: item.value };
    default: return { op: item.op, target: item.field_key, value: item.value };
  }
};

// fill-plan 실행. 옵션:
//   resolutions[row] = 정식코드   — 사용자가 미리 고른 라인 품목(HITL 결과)
//   commitSave                    — 저장 확인 모달의 [확인]까지 누름(데모 자동완결). 기본은 멈춤(사람이 확인).
//   confirmTarget                 — 확인 버튼 셀렉터(기본 #confirm-ok)
//   stopOnError                   — 액션 실패 시 중단(기본 true)
// 반환: { ok, results[], saveClicked, committed, awaitingConfirm, finalSignature, prNo, error?, failedAt? }
UDCA.runPlan = async function (plan, opts) {
  opts = opts || {};
  const doc = opts.doc || document;
  const resolutions = opts.resolutions || {};
  const results = [];

  // 0) 이동(네비게이션): 대상 화면까지 메뉴/행 클릭. 누가 이동했든 "도착"만 보면 이어간다(§6).
  for (const step of (plan && plan.nav) || []) {
    const r = await UDCA.exec({ op: "click", target: step.target }, doc);
    results.push({ op: "nav", target: step.target, label: step.label, ok: !!r.ok, error: r.error });
    if (!r.ok && opts.stopOnError !== false) {
      return { ok: false, results, error: r.error || "이동 실패", failedAt: { op: "nav", target: step.target, label: step.label } };
    }
  }

  // 조회: 도착한 화면을 읽어 보고(되돌릴 일 없음).
  let read = null;
  if (plan && plan.read) read = UDCA.readScreen ? UDCA.readScreen(doc) : null;

  for (const item of (plan && plan.items) || []) {
    const action = UDCA.itemToAction(item);
    // 라인 품목(검색선택): 미리 고른 코드가 있으면 그걸로, 없으면 일단 검색해 후보를 본다.
    if (item.op === "searchSelect" && item.row != null && resolutions[item.row] != null) {
      action.value = resolutions[item.row];
    }
    let r = await UDCA.exec(action, doc);
    // 후보가 여럿인데 미해소(needs_resolution)면 첫 후보를 자동 선택해 데모를 진행하되,
    // 전체 후보를 보고에 남겨 "어느 후보 중 무엇을 골랐나"가 드러나게 한다(정식 코드 찾기 투명성).
    let autoPicked = null;
    if (item.op === "searchSelect" && r.ok && r.hitl && (r.candidates || []).length) {
      autoPicked = (r.candidates[0] || {}).code;
      r = await UDCA.exec({ op: "searchSelect", target: action.target, query: action.query, value: autoPicked }, doc);
    }
    results.push({
      op: item.op, target: action.target, label: item.label, ok: !!r.ok,
      readBack: r.readBack, picked: r.picked, autoPicked,
      candidates: r.candidates, error: r.error,
    });
    if (!r.ok && opts.stopOnError !== false) {
      return { ok: false, results, error: r.error || "액션 실패", failedAt: item };
    }
  }

  // 저장 = 되돌릴 수 없는 행동. 클릭하면 목업은 확인 모달을 띄운다.
  // 기본(commitSave=false): 거기서 멈춰 *사람이 페이지에서 [확인]*을 누르게 둔다(강한 HITL).
  let saveClicked = false;
  if (plan && plan.save && plan.save.target) {
    await UDCA.exec({ op: "click", target: plan.save.target }, doc);
    saveClicked = true;
    if (opts.commitSave) {
      await UDCA.exec({ op: "click", target: opts.confirmTarget || "#confirm-ok" }, doc);
    }
  }

  const finalSignature = UDCA.signature ? UDCA.signature(doc) : null;
  const prEl = doc.querySelector("#pr-no");
  return {
    ok: true,
    results,
    read,
    saveClicked,
    committed: !!opts.commitSave,
    awaitingConfirm: saveClicked && !opts.commitSave,
    finalSignature,
    prNo: prEl ? (prEl.textContent || "").trim() : null,
  };
};
