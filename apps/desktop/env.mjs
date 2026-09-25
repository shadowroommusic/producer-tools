// core env 装箱（desktop-packaging-plan.md §6.2 / §6.4-②）：
// 首启（或 ENV_STAMP 变化 / venv 坏了）时，用包内 pbs runtime 离线建 _venvs/.core，
// 装上 wheels/core 里全部 wheel，再把 7 个 core 插件的 _venvs/<repo> 软链过去——
// 桥的 pythonFor() 找 _venvs/<repo>/bin/python，软链目录即命中，桥零改动。
// soundfont / splitter 不在这步：soundfont 有独立 env（fluidsynth dylib 是第 3 步），
// splitter 重依赖首用下载（第 3 步）。这台机器上它们继续用第 1 步迁移过来的 venv。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// pythonFor() 用的 _venvs/<repo> 目录名（= 各仓目录名）。converter 的 repo 目录名是
// rekordbox-serato-bridge、grabber 是 ShadowMusicGrabber——与 REGISTRY 一一对应。
const CORE_REPOS = [
  "rekordbox-serato-bridge", "audio-analysis-dedupe", "set-planner",
  "shadow-music-generator", "steward", "library", "ShadowMusicGrabber",
];

function stampOf(resourcesPath) {
  const buildId = readFileSync(join(resourcesPath, "python-runtime", ".build-id"), "utf8").trim();
  const wheels = readdirSync(join(resourcesPath, "wheels", "core"))
    .filter((f) => f.endsWith(".whl")).sort()
    .map((f) => `${f}:${statSync(join(resourcesPath, "wheels", "core", f)).size}`)
    .join("|");
  return createHash("sha256").update(`${buildId}\n${wheels}`).digest("hex");
}

function healthy(corePython) {
  const r = spawnSync(corePython, ["-c", "import sys"], { timeout: 10_000, stdio: "ignore" });
  return r.status === 0;
}

/**
 * 打包态每次启动调用。幂等：stamp 相同且解释器活、软链齐 → 直接返回（~150ms）。
 * 任何不满足 → 离线重建（venv + pip --no-index，全程不碰网络）。
 */
export function ensureCoreEnv(home) {
  const runtimeDir = join(process.resourcesPath, "python-runtime");
  const wheelsDir = join(process.resourcesPath, "wheels", "core");
  if (!existsSync(runtimeDir) || !existsSync(wheelsDir)) return; // 旧包没带这节，静默跳过

  const coreDir = join(home, "_venvs", ".core");
  const corePython = join(coreDir, "bin", "python");
  const stampFile = join(home, "ENV_STAMP");
  const linksOk = CORE_REPOS.every((r) => existsSync(join(home, "_venvs", r, "bin", "python")));
  const stamp = stampOf(process.resourcesPath);
  if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === stamp
      && healthy(corePython) && linksOk) {
    return;
  }

  const t0 = Date.now();
  console.log(`[env] (re)building .core (stamp ${stamp.slice(0, 8)}) ...`);
  rmSync(coreDir, { recursive: true, force: true });

  // venv 的解释器指向包内 runtime 的绝对路径：app 原地升级路径不变；用户把 .app 挪到
  // /Applications 后路径失效 → healthy() 探针失败 → 这里自动重建，不用搬家工具。
  let r = spawnSync(join(runtimeDir, "bin", "python3"), ["-m", "venv", coreDir], { stdio: "inherit" });
  if (r.status !== 0) throw new Error("venv creation failed");

  const whls = readdirSync(wheelsDir).filter((f) => f.endsWith(".whl")).sort()
    .map((f) => join(wheelsDir, f));
  // --no-index：只吃包内 wheel，断网首启也能建（§6.2 验收 1）
  r = spawnSync(corePython, ["-m", "pip", "install", "--no-index", "--no-input", "--quiet", ...whls],
    { stdio: "inherit" });
  if (r.status !== 0) throw new Error("pip install --no-index failed");

  for (const repo of CORE_REPOS) {
    const link = join(home, "_venvs", repo);
    rmSync(link, { recursive: true, force: true }); // 会覆盖第 1 步迁移过来的旧 3.9 venv——core 插件从此归 .core 管
    symlinkSync(".core", link);
  }
  writeFileSync(stampFile, stamp);
  console.log(`[env] .core ready: ${whls.length} wheels, 7 plugins linked, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
