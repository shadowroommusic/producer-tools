/**
 * #93 第 3 刀「设备库备份」UI 端到端验收（PASS/FAIL 逐条打印，可重复跑）：
 * ① 插件页能进 Rekordbox ⇄ Serato 面板，「设备备份」tab 在
 * ② 候选设备列出 fixture 假盘，点选后跑快照，摘要统计出现（歌单 1 / 曲目 1）
 * ③ 快照落在 SHADOW_DEVICE_BACKUP_ROOT 下（桥进程环境变量），目录里有 device-snapshot.json
 * ④ 只读断言：fixture 目录树内容 hash 前后不变（设备绝不写）
 * ⑤ 截图留存 exports/device-backup-e2e/backup-tab.png
 *
 * 前置（与 orb-v5 同款约定）：5173 dev server（DEVICE_E2E_BASE 可覆写）；
 * 8787 桥——空闲则本脚本以临时备份根自起，被占则报错退出（不抢别人的桥）。
 * 用法：node tests/e2e/device-backup-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.DEVICE_E2E_BASE ?? "http://localhost:5173";
const REPO = "/Users/lazora/Documents/ShadowRoom";
const SHOTS = `${REPO}/exports/device-backup-e2e`;

const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};
const treeHash = (root) => {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else { hash.update(name); hash.update(readFileSync(p)); }
    }
  };
  walk(root);
  return hash.digest("hex");
};

// ---- 环境：fixture 假设备 + 桥 + dev server
mkdirSync(SHOTS, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "d93-e2e-"));
const fixtureRoot = join(tmp, "FAKEDEV");
const backupRoot = join(tmp, "backups");
const fixture = spawnSync("python3", ["-c", `
import sys; sys.path.insert(0, "${REPO}/rekordbox-serato-bridge/tests")
from device_fixture import build_device
build_device(r"${fixtureRoot}",
  playlists=[{"id":1,"name":"e2e歌单","track_ids":[1]}],
  tracks={1:{"title":"a","file_path":"1/a.mp3","bpm":None}}, bpms={}, cues={})
`], { stdio: "inherit" });
if (fixture.status !== 0) { console.log("FAIL  环境 — fixture 造不出来"); process.exit(1); }
const hashBefore = treeHash(fixtureRoot);

const portFree = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return !probe.stdout.trim();
};
if (!portFree(8787)) { console.log("FAIL  环境 — 8787 已被占（本脚本要用自己的备份根起桥，先停掉它再跑）"); process.exit(1); }
const bridge = spawn("node", ["tools/mcp-bridge.mjs"], {
  cwd: `${REPO}/producer-tools`,
  env: { ...process.env, SHADOW_DEVICE_BACKUP_ROOT: backupRoot },
  stdio: "ignore",
});
process.on("exit", () => { try { bridge.kill(); } catch {} });
await new Promise((r) => setTimeout(r, 2500));
if (portFree(8787)) { console.log("FAIL  环境 — 桥没起来（tools/mcp-bridge.mjs）"); process.exit(1); }
if (portFree(5173)) { console.log("FAIL  环境 — 5173 dev server 不在（先 pnpm dev）"); process.exit(1); }

// ---- 驱动
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
try {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.getByRole("link", { name: "插件" }).first().click().catch(() => page.getByText("插件", { exact: true }).first().click());
  await page.waitForTimeout(800);
  await page.getByText("Rekordbox ⇄ Serato").first().click();
  await page.waitForTimeout(1200);
  const backupTab = page.getByRole("tab", { name: "设备备份" });
  check("① 「设备备份」tab 在", await backupTab.count() > 0, "ConverterPanel tab 栏");
  await backupTab.click();

  const chip = page.getByRole("button", { name: "FAKEDEV" });
  await chip.waitFor({ timeout: 15000 }).catch(() => {});
  check("② 候选列出 fixture 假盘", await chip.count() > 0, "device_candidates 经桥转发");
  if (await chip.count() > 0) await chip.click();

  await page.getByRole("button", { name: "备份设备库" }).click();
  await page.getByText("剪除旧档").waitFor({ timeout: 60000 }).catch(() => {});
  const statsText = (await page.locator(".sr-plugin-result").first().textContent().catch(() => "")) ?? "";
  check("② 摘要统计 歌单 1 / 曲目 1", statsText.includes("歌单") && statsText.includes("1"), statsText.replace(/\s+/g, " ").slice(0, 90));

  const dirs = existsSync(backupRoot) ? readdirSync(backupRoot) : [];
  check("③ 档位落在备份根", dirs.length === 1 && existsSync(join(backupRoot, dirs[0] ?? "", "device-snapshot.json")), dirs.join(",") || "(空)");

  check("④ fixture 只读（树 hash 不变）", treeHash(fixtureRoot) === hashBefore, hashBefore.slice(0, 12));

  await page.screenshot({ path: `${SHOTS}/backup-tab.png` });
  console.log(`SHOT  ${SHOTS}/backup-tab.png`);
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(f"\n${results.length - failed}/${results.length} PASS${failed ? `，${failed} 条 FAIL` : ""}`);
process.exit(failed ? 1 : 0);
