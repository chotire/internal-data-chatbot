// WebSquare 어댑터 (스텁). 플러그러블 구조를 보여주기 위한 자리표시자.
//
// 실제 구현 시: 전역 데이터모델(WebSquare/$w/scwin)에서 그리드 전체 데이터를 읽어야 하며,
// 그러려면 content script 를 MAIN world 로 주입해 페이지 전역에 접근해야 한다.
// (현재 스파이크 범위 밖. detect 만 마련해두고 extract 는 미구현으로 폴백 유도.)

(function () {
  UDC.register({
    name: "websquare",
    priority: 10, // html 폴백보다 높음 (단, extract 미구현이라 throw → html 로 폴백)
    detect(doc) {
      // DOM 클래스 마커로 1차 감지 (전역 객체 확인은 MAIN world 필요)
      return !!doc.querySelector('[class*="w2grid"], .gridView, [id^="grd"]');
    },
    extract() {
      throw new Error(
        "websquare 어댑터 미구현(스텁): MAIN world 에서 데이터모델 접근 필요."
      );
    },
  });
})();
