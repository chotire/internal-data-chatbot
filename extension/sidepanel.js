// 얇은 브리지: 서버 챗봇 UI(iframe) ↔ 익스텐션(background → content script).
// iframe 은 우리 서버 origin 이므로, 그쪽에서 온 메시지만 신뢰한다.

const SERVER_ORIGIN = "http://localhost:8000";
const iframe = document.getElementById("chat");
// 캐시버스터로 항상 최신 챗봇 UI 로드 (서버 배포 즉시 반영)
iframe.src = SERVER_ORIGIN + "/chat?t=" + Date.now();

window.addEventListener("message", (e) => {
  if (e.origin !== SERVER_ORIGIN) return; // origin 검증
  const msg = e.data;
  if (msg && msg.type === "UDC_PICK") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      chrome.runtime.sendMessage({ type: "UDC_PICK", tabId }, (resp) => {
        iframe.contentWindow.postMessage(
          { type: "UDC_PICK_DONE", ok: !!(resp && resp.ok), selector: resp && resp.selector, error: resp && resp.error },
          SERVER_ORIGIN
        );
      });
    });
    return;
  }
  if (msg && msg.type === "UDC_PICK_CLEAR") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.runtime.sendMessage({ type: "UDC_PICK_CLEAR", tabId: tabs && tabs[0] && tabs[0].id });
    });
    return;
  }
  if (msg && msg.type === "UDC_HIGHLIGHT") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      chrome.runtime.sendMessage({ type: "UDC_HIGHLIGHT", tabId }, (resp) => {
        iframe.contentWindow.postMessage(
          { type: "UDC_HIGHLIGHT_DONE", ok: !!(resp && resp.ok), count: resp && resp.count, error: resp && resp.error },
          SERVER_ORIGIN
        );
      });
    });
    return;
  }
  // v0.4 폼 인식 요청 → background 가 FormContext 추출 → iframe 으로 반환
  if (msg && msg.type === "UDC_REQUEST_FORM") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      chrome.runtime.sendMessage({ type: "UDC_EXTRACT_FORM", tabId }, (resp) => {
        iframe.contentWindow.postMessage(
          {
            type: "UDC_FORM", requestId: msg.requestId,
            ok: !!(resp && resp.ok), formContext: resp && resp.formContext,
            error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message),
          },
          SERVER_ORIGIN
        );
      });
    });
    return;
  }
  // v0.4 계획 실행 요청 → background 가 페이지에서 fill-plan 실행 → 결과 반환
  if (msg && msg.type === "UDC_RUN_PLAN") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      chrome.runtime.sendMessage(
        { type: "UDC_RUN_PLAN", tabId, plan: msg.plan, commitSave: msg.commitSave, resolutions: msg.resolutions },
        (resp) => {
          iframe.contentWindow.postMessage(
            {
              type: "UDC_RUN_RESULT", requestId: msg.requestId,
              ok: !!(resp && resp.ok), result: resp && resp.result,
              error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message),
            },
            SERVER_ORIGIN
          );
        }
      );
    });
    return;
  }
  // v0.4 매핑 모드 요청 → background 가 메뉴 순회 관찰 수집 → iframe 으로 반환
  if (msg && msg.type === "UDC_REQUEST_MAP") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      chrome.runtime.sendMessage({ type: "UDC_MAP_WALK", tabId, targets: msg.targets }, (resp) => {
        iframe.contentWindow.postMessage(
          {
            type: "UDC_MAP", requestId: msg.requestId,
            ok: !!(resp && resp.ok), observations: resp && resp.observations,
            error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message),
          },
          SERVER_ORIGIN
        );
      });
    });
    return;
  }
  if (msg && msg.type === "UDC_REQUEST_SCREEN") {
    // 이 사이드패널이 속한 창의 활성 탭을 추출 대상으로 지정 (다른 탭/창 영향 배제)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs && tabs[0] && tabs[0].id;
      chrome.runtime.sendMessage({ type: "UDC_GET_SNAPSHOT", tabId, useRecipe: msg.useRecipe }, (resp) => {
        iframe.contentWindow.postMessage(
          {
            type: "UDC_SCREEN",
            requestId: msg.requestId,
            ok: !!(resp && resp.ok),
            snapshot: resp && resp.snapshot,
            error: (resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message),
          },
          SERVER_ORIGIN
        );
      });
    });
  }
});
