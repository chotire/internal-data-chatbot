// 스위트: 서버측 recipe 검증 (command) — 파이썬 테스트를 실행해 종료코드로 판정.
// command 유형은 언어 무관하게 외부 도구/테스트를 같은 리포트에 묶는 방법이다.
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
  id: "server-recipe",
  title: "서버 recipe 검증(매칭·JSONC·스키마)",
  kind: "command",
  description: "uv run python tests/server/test_recipes.py — 종료코드 0=성공.",
  cases: [
    { id: "S1", name: "URL 매칭/JSONC 파싱/스키마 검증", expect: "파이썬 체크 전부 통과(exit 0)" },
  ],
  async run(testCase) {
    const { code, out } = await runCmd("uv", ["run", "python", "tests/server/test_recipes.py"], ROOT);
    const last = out.trim().split("\n").filter(Boolean).pop() || "";
    return { ok: code === 0, note: code === 0 ? last : `exit ${code} · ${last}` };
  },
};
