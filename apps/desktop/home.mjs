// 第二刀第 1 步（desktop-packaging-plan.md §6.1，评审 bus #111）：解析桌面态 HOME、
// 首启迁移向导、插件源码同步。桥零改动——只通过 SHADOWROOM_HOME 环境变量告诉桥家在哪。
//
// 为什么 HOME 默认是 userData（~/Library/Application Support/ShadowRoom）而不是沿用的
// ~/Documents/ShadowRoom：未签名 app 在 launchd（双击/open）下读 ~/Documents 会触发
// TCC「文件与文件夹」，没人点弹窗时 python 全部阻塞在 open()、插件 30s 超时全 error
// （第一刀实测，风险清单 #11）。userData 不受 TCC 保护，从根上消除。
import { app, dialog } from "electron";
import { spawnSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, readlinkSync,
  readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { statfs } from "node:fs/promises";

// 用户数据目录（封闭清单！绝不整体拷贝旧家——里面有 github-recovery-codes.txt、
// AGENTS.md、_bus/_backups 这类工作区文件）。2026-09-26 实测盘点补充：
// _steward（管家 ledger）、stems/_stems-cache/stem-splitter-jobs（分轨产物与缓存）、
// imports（导入音频）在 §6.1 初稿里漏了，此为落地修正。
const DATA_DIRS = [
  "_library", "recordings", "exports", "_soundfonts", "_steward",
  "stems", "_stems-cache", "stem-splitter-jobs", "imports",
];
// 机器环境（过渡策略，§6.4 第 2 步 python 装箱后由包内 runtime 取代）：
// venv 不搬插件起不来；又不能软链回旧家——软链解析后的真实路径仍在 ~/Documents 下，
// open 起的进程读它会再次踩 TCC（首刀实测）。所以整目录 clonefile 复制进新家，
// 并把指向旧家的绝对软链改写到新家（audio-analysis/generator 的 bin/python 是
// 绝对软链指向 stem-splitter venv，实测）。
const VENV_SKIP = new Set(["mamba-root"]); // 336M 无引用遗留（实测），不搬

// 测试缝（不动真家也能验收 §6.1.2/3/4）：
//   SHADOWROOM_LEGACY_HOME   旧家位置（默认 ~/Documents/ShadowRoom）
//   SHADOWROOM_MIGRATE_CHOICE  a|b|c 跳过向导弹窗直接选（脚本/CI 用；不设则弹真窗）
function legacyHome() {
  return resolve(process.env.SHADOWROOM_LEGACY_HOME
    ?? join(app.getPath("home"), "Documents", "ShadowRoom"));
}

function configPath() { return join(app.getPath("userData"), "shadowroom-config.json"); }
function markerPath(home) { return join(home, ".migrated.json"); }

function readConfig() {
  try { return JSON.parse(readFileSync(configPath(), "utf8")); } catch { return {}; }
}

function copyTree(src, dst) {
  rmSync(dst, { recursive: true, force: true }); // 中断重试语义：半成品先清再拷
  const r = spawnSync("/bin/cp", ["-c", "-R", src, dst], { stdio: "ignore" });
  if (r.status !== 0) cpSync(src, dst, { recursive: true }); // 非 APFS / 跨卷退普通递归拷贝
}

// 指向旧家的绝对软链改写到新家（只动 _venvs 与 bin）。venv 对 Xcode python 等外部
// 绝对链保持原样——那些路径不在 ~/Documents 下，TCC 不拦。
// 比较前要 realpath 归一：实测 cp -c -R 会把软链目标存成 realpath 形式（/tmp → /private/tmp），
// 字面前缀比对会漏（fixture 测试抓到）。
function rewriteLegacySymlinks(root, oldHome, newHome) {
  if (!existsSync(root)) return 0;
  let oldReal = oldHome;
  try { oldReal = realpathSync(oldHome); } catch { /* 旧家已不可达就按字面比 */ }
  const relUnder = (t) => {
    for (const base of [oldHome, oldReal]) {
      if (t.startsWith(base + "/")) return t.slice(base.length);
    }
    return null;
  };
  let fixed = 0;
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isSymbolicLink()) {
        let target;
        try { target = readlinkSync(p); } catch { continue; }
        const rel = relUnder(target);
        if (rel !== null) {
          rmSync(p, { force: true });
          symlinkSync(join(newHome, rel), p);
          fixed++;
        }
      }
    }
  };
  walk(root);
  return fixed;
}

function dirStats(p) {
  let files = 0, bytes = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { files++; bytes += statSync(f).size; }
    }
  };
  walk(p);
  return { files, bytes };
}

function duBytes(paths) {
  let kb = 0;
  for (const p of paths) {
    if (!existsSync(p)) continue;
    const r = spawnSync("/usr/bin/du", ["-sk", p], { encoding: "utf8" });
    if (r.status === 0) kb += Number(r.stdout.split("\t")[0]) || 0;
  }
  return kb * 1024;
}

function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }

// 脚本/CI 模式（设了 SHADOWROOM_MIGRATE_CHOICE）跳过所有向导弹窗——
// showMessageBoxSync 会阻塞等人点，自动化验收没法点。产品路径（未设 env）弹真窗。
const HEADLESS = ["a", "b", "c"].includes(process.env.SHADOWROOM_MIGRATE_CHOICE);
function box(opts) {
  if (HEADLESS) return 0;
  return dialog.showMessageBoxSync(opts);
}

/** 弹三选一向导。返回 "a"（迁移）| "b"（全新）| "c"（继续用旧工作区）。 */
function askWizard(old, dataBytes) {
  const buttons = ["迁移（推荐）", "全新开始", "继续用旧工作区"];
  const idx = box({
    type: "question",
    title: "ShadowRoom 首次启动",
    message: `检测到旧版数据：${old}\n数据约 ${mb(dataBytes)} MB。要怎么处理？`,
    detail:
      "「迁移（推荐）」：把曲库、录音、导出、分轨、音色、管家记忆复制到新的应用数据目录。"
      + "克隆复制，几乎不额外占空间；旧目录原样保留（复制不是移动，随时可以重来）。\n\n"
      + "「全新开始」：不复制任何东西，从空库开始。\n\n"
      + "「继续用旧工作区」：高级选项——直接读写上面的旧目录。会触发 macOS 文稿权限弹窗（要点一次允许），"
      + "并且和开发实例共用同一份数据。",
    noLink: true,
    buttons,
    defaultId: 0,
  });
  return ["a", "b", "c"][idx];
}

function migrationTargets(old) {
  const dataDirs = DATA_DIRS.filter((d) => existsSync(join(old, d)));
  const venvs = existsSync(join(old, "_venvs"))
    ? readdirSync(join(old, "_venvs"), { withFileTypes: true })
        .filter((e) => e.isDirectory() && !VENV_SKIP.has(e.name)).map((e) => e.name)
    : [];
  return { dataDirs, venvs, hasBin: existsSync(join(old, "bin")) };
}

function runMigration(old, home) {
  const { dataDirs, venvs, hasBin } = migrationTargets(old);
  const need = duBytes([
    ...dataDirs.map((d) => join(old, d)),
    ...venvs.map((v) => join(old, "_venvs", v)),
    ...(hasBin ? [join(old, "bin")] : []),
  ]);
  console.log(`[home] migration plan: ${dataDirs.length} data dirs + ${venvs.length} venvs, need≈${mb(need)}MB`);

  const stats = {};
  try {
    for (const d of dataDirs) {
      copyTree(join(old, d), join(home, d));
      stats[d] = dirStats(join(home, d));
      console.log(`[home] copied ${d} (${stats[d].files} files, ${mb(stats[d].bytes)}MB)`);
    }
    for (const v of venvs) copyTree(join(old, "_venvs", v), join(home, "_venvs", v));
    if (hasBin) copyTree(join(old, "bin"), join(home, "bin"));
    const fixed = rewriteLegacySymlinks(join(home, "_venvs"), old, home)
      + rewriteLegacySymlinks(join(home, "bin"), old, home);
    console.log(`[home] copied ${venvs.length} venvs + bin, rewrote ${fixed} legacy symlinks`);
  } catch (err) {
    // 失败回退：清半成品、不写标记（下次启动重新提供迁移）；旧家是复制源，天然完好
    for (const d of [...dataDirs, "_venvs", "bin"]) rmSync(join(home, d), { recursive: true, force: true });
    box({
      type: "error", title: "迁移失败",
      message: `复制中断：${err.message ?? err}`,
      detail: "已清理未完成的内容，旧数据未受影响。下次启动会再次提供迁移选项。",
    });
    console.error(`[home] migration FAILED: ${err.message ?? err}`);
    return false;
  }

  writeFileSync(markerPath(home), JSON.stringify({
    choice: "migrate", source: old, date: new Date().toISOString(), stats,
  }, null, 2));
  const totalFiles = Object.values(stats).reduce((a, s) => a + s.files, 0);
  const totalBytes = Object.values(stats).reduce((a, s) => a + s.bytes, 0);
  box({
    type: "info", title: "迁移完成",
    message: `已复制 ${totalFiles} 个文件（约 ${mb(totalBytes)} MB）到新位置。`,
    detail: `旧目录 ${old} 原样保留，确认一切正常后可以手动删除。`,
  });
  console.log(`[home] migration done: ${totalFiles} files, ${mb(totalBytes)}MB, marker written`);
  return true;
}

/**
 * 解析桌面态 HOME。优先级：配置文件覆写 → SHADOWROOM_HOME 环境变量 → userData 默认
 * （默认路径上没有 .migrated.json 且旧家有数据时，走首启向导）。
 * 返回 { home, managed }：managed=true 表示这是 app 自己的默认家（userData），可以往里
 * 同步插件源码；覆写模式（c/env/config）下 home 是用户的地方——那里的 <repo> 是用户自己的
 * 检出（dev 工作区），**绝不允许** rm+覆盖（fixture 测试抓到过：sync 会删掉用户 git 检出）。
 * dev 态（未打包）不调用本函数——桥用自己的默认 ~/Documents/ShadowRoom，dev 工作流零变化。
 */
export async function resolveDesktopHome() {
  const cfg = readConfig();
  if (cfg.home && existsSync(cfg.home)) {
    console.log(`[home] SHADOWROOM_HOME=${cfg.home} (config-override)`);
    return { home: cfg.home, managed: false };
  }
  if (cfg.home) {
    console.log(`[home] config override points to missing path, ignored: ${cfg.home}`);
    delete cfg.home;
    writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  }
  if (process.env.SHADOWROOM_HOME) {
    console.log(`[home] SHADOWROOM_HOME=${resolve(process.env.SHADOWROOM_HOME)} (env-override)`);
    return { home: resolve(process.env.SHADOWROOM_HOME), managed: false };
  }

  const home = app.getPath("userData");
  const old = legacyHome();
  if (existsSync(markerPath(home))) return { home, managed: true };
  if (!existsSync(old) || !DATA_DIRS.some((d) => existsSync(join(old, d)))) {
    if (existsSync(old)) writeFileSync(markerPath(home), JSON.stringify({ choice: "none" }));
    return { home, managed: true };
  }

  const { dataDirs, venvs, hasBin } = migrationTargets(old);
  const need = duBytes([
    ...dataDirs.map((d) => join(old, d)),
    ...venvs.map((v) => join(old, "_venvs", v)),
    ...(hasBin ? [join(old, "bin")] : []),
  ]);
  let free = await statfs(home).then((s) => s.bavail * Number(s.bsize), () => Infinity);
  if (free < need * 1.05) {
    // 空间不足：不给迁移选项，二选一。克隆复制正常几乎不占新空间，这里防的是
    // du 与实际不符、非 APFS 回退路径、以及将来数据涨大。
    const idx = box({
      type: "warning", title: "磁盘空间不足",
      message: `迁移需要约 ${mb(need)} MB，当前只剩 ${mb(free)} MB。`,
      detail: "可以「全新开始」，或「继续用旧工作区」（不复制任何数据）。",
      buttons: ["全新开始", "继续用旧工作区"], defaultId: 0,
    });
    console.log(`[home] space guard: need ${mb(need)}MB > free ${mb(free)}MB`);
    return applyChoice(idx === 0 ? "b" : "c", old, home);
  }

  let choice = process.env.SHADOWROOM_MIGRATE_CHOICE;
  if (!["a", "b", "c"].includes(choice)) choice = askWizard(old, duBytes(dataDirs.map((d) => join(old, d))));

  return applyChoice(choice, old, home);
}

async function applyChoice(choice, old, home) {
  if (choice === "a") {
    runMigration(old, home);
  } else if (choice === "b") {
    writeFileSync(markerPath(home), JSON.stringify({ choice: "fresh" }));
    console.log("[home] fresh start chosen, marker written");
  } else if (choice === "c") {
    writeFileSync(configPath(), JSON.stringify({ home: old }, null, 2));
    writeFileSync(markerPath(home), JSON.stringify({ choice: "legacy" }));
    console.log(`[home] legacy workspace chosen, homeOverride=${old}`);
    return { home: old, managed: false };
  }
  return { home, managed: true };
}

/**
 * 打包态每次启动把 Resources/plugins/<repo> 同步到 HOME/<repo>（桥按 HOME/<repo>/mcp_server.py
 * 找源码）。源码目录不是用户数据，整目录换新（__pycache__ 一并重建，代价毫秒级）；
 * 用户数据全在 DATA_DIRS 列的独立目录里，不受影响。第二刀第 2 步引入 stamp 后可改为按需同步。
 */
export function syncPluginSources(home) {
  const srcRoot = join(process.resourcesPath, "plugins");
  if (!existsSync(srcRoot)) return; // 第一刀的旧包没有这一节，静默跳过
  mkdirSync(home, { recursive: true });
  let count = 0;
  for (const repo of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!repo.isDirectory()) continue;
    const dst = join(home, repo.name);
    rmSync(dst, { recursive: true, force: true });
    cpSync(join(srcRoot, repo.name), dst, { recursive: true });
    count++;
  }
  console.log(`[home] synced ${count} plugin repos into HOME`);
}
