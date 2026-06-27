// 스위트: 서버측 v0.3 툴-콜링/스트리밍 검증 (command) — 파이썬 테스트를 실행해 종료코드로 판정.
// OpenAI 없이 결정론적으로 가능한 부분만(이벤트 매핑·citations·_build_messages·SSE 프레이밍).
// 실제 OpenAI 연동(툴 라우팅 정확도·이벤트 타입명·모델 지원)은 자동화 불가 → 수동.
import { spawn } from "node:child_process";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

function runCmd(cmd, args, cwd) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, shell: false });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.on("error", (e) => resolve({ code: -1, out: String(e) }));
  });
}

export default {
  id: "server-stream",
  title: "서버 툴-콜링/스트리밍 검증(이벤트 매핑·SSE)",
  kind: "command",
  description: "uv run python tests/server/test_stream.py — 종료코드 0=성공. stream_answer 이벤트 매핑·citations·_build_messages·/api/chat/stream SSE 프레이밍(OpenAI 스텁).",
  cases: [
    { id: "ST1", name: "툴-콜링 이벤트 매핑/citations/SSE 프레이밍", expect: "파이썬 체크 전부 통과(exit 0)" },
  ],
  async run(testCase) {
    const { code, out } = await runCmd("uv", ["run", "python", "tests/server/test_stream.py"], ROOT);
    const last = out.trim().split("\n").filter(Boolean).pop() || "";
    return { ok: code === 0, note: code === 0 ? last : `exit ${code} · ${last}` };
  },
};
