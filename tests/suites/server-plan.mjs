// 스위트: 서버측 v0.4 두뇌(fill-plan)/그래프 검증 (command) — 파이썬 테스트를 실행해 종료코드로 판정.
// LLM·브라우저 없이 결정론적으로 가능한 부분(의도 파싱·fill-plan·게이트·그래프 질의·엔드포인트).
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
  id: "server-plan",
  title: "서버 두뇌 fill-plan/그래프 검증(의도·계획·게이트)",
  kind: "command",
  description: "uv run python tests/server/test_plan.py — 종료코드 0=성공. parse_intent·plan(fill-plan)·decide_gate·FileGraphStore·/api/agent/plan(MockBrain 결정론).",
  cases: [
    { id: "PL1", name: "의도 파싱·fill-plan·게이트·그래프·엔드포인트", expect: "파이썬 체크 전부 통과(exit 0)" },
  ],
  async run() {
    const { code, out } = await runCmd("uv", ["run", "python", "tests/server/test_plan.py"], ROOT);
    const last = out.trim().split("\n").filter(Boolean).pop() || "";
    return { ok: code === 0, note: code === 0 ? last : `exit ${code} · ${last}` };
  },
};
