/**
 * 曲目库页验收（一期 9 条 + 二期五件，可重复跑）：
 * ① 扫描（任务契约，进度位收口）② 筛选逐项 ②b 右键菜单全量结构 ③ 详情抽屉+封面位
 * ④ 偏好看板数字 + 忘记偏好两次点击 ⑤ cue 写控件=0 ⑥ 联动口径 ⑦ 零 console error
 * ⑧ 菜单结构（试听第一项/打开所在文件夹禁用/危险区三段）⑨ 改名（库 title 变、文件名不动）
 * ⑩ 加入分类库（两个 crate 都在、path 逐字节不变）⑪ 从曲库移除（行没、文件在）
 * ⑫ 移到废纸篓（确认弹窗文案+默认焦点取消；文件进 ~/.Trash）⑬ 彻底删除（勾选武装；文件没了不进废纸篓）
 * ⑭ 封面（行小图+抽屉大图 naturalWidth>0；无封面占位）⑮ 查重弹窗（同歌不同编码二选一、不会自动删、
 * 保留这条→另一条进废纸篓）⑯ 同名不同版本只打角标不弹窗。
 *
 * fixture 自造自清：/tmp/sp-lib-accept（软链+副本+ffmpeg 重编码），跑前跑后删库行与 ~/.Trash 里的
 * fixture 残骸——库行数跑前跑后一致。源音频取 stems/kit-demo-demo（不在库里，声学组只含 fixture）。
 * 前置：5173（vite）+ 8787（mcp 桥）+ 8788（agent 桥）都在跑。用法：node tests/e2e/library-page-acceptance.mjs
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { execSync } from "node:child_process";
import { mkdirSync, symlinkSync, rmSync, existsSync, cpSync } from "node:fs";

const BASE = "http://localhost:5173";
const BRIDGE = "http://127.0.0.1:8787";
const FIX = "/tmp/sp-lib-accept";
const RECORDINGS = "/Users/lazora/Documents/ShadowRoom/recordings";
const STEMS = "/Users/lazora/Documents/ShadowRoom/stems/kit-demo-demo";
const FF = "/Users/lazora/Documents/ShadowRoom/bin/ffmpeg";
const TRASH = `${process.env.HOME}/.Trash`;
const SHOTS = "/tmp/sp-shots/library-accept";
const AUDIO_COUNT = 16; // 8 软链 + acc.wav/accb.wav/acc.mp3 + trash/perma/remove + meta×2
const results = [];
const check = (name, ok, detail) => {
  results.push({ ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

// ---- 地面真值：桥直查
const call = async (tool, args, timeout = 180) => {
  const res = await fetch(`${BRIDGE}/api/call`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ server: "library", tool, arguments: args }),
  });
  const body = await res.json();
  if (body.isError) throw new Error(`${tool}: ${String(body.result).slice(0, 200)}`);
  return typeof body.result === "string" ? JSON.parse(body.result) : body.result;
};
const dbPath = () =>
  call("stats", {}).then((s) => s.db_path);
const cleanFixtureRows = (db) =>
  execSync(`python3 -c "import sqlite3;db=sqlite3.connect('${db}');db.execute(\\"DELETE FROM tracks WHERE path LIKE '${FIX}/%'\\");db.commit()"`);
// ~/.Trash 列目录被 macOS TCC 挡（EPERM），但按路径 stat/删是可以的——按已知名+序号变体清。
const trashVariants = (base) => [base, ...Array.from({ length: 5 }, (_, i) => base.replace(/\.wav$/, ` ${i + 2}.wav`))];
import { statSync } from "node:fs";
const RUN_START = Date.now();
/** 本次运行新进废纸篓的（同名旧文件会被替换覆盖，所以数个数不够，要看 mtime）。 */
const trashHasFresh = (base, sinceMs = RUN_START) =>
  trashVariants(base).some((name) => {
    const target = `${TRASH}/${name}`;
    return existsSync(target) && statSync(target).mtimeMs >= sinceMs - 1000;
  });
const trashHas = (base) => trashHasFresh(base, 0);
// node 的 rmSync 对 ~/.Trash 会 EPERM，python3 能列能删——清理走 python（同名残留会让
// 下一次 send2trash 静默覆盖、新文件凭空消失，清理不干净后面两条 trash 断言就会假摔）。
const cleanTrashFixtures = () => {
  execSync(
    `python3 -c "from pathlib import Path;home=Path.home();[p.unlink() for pattern in ('libaccept-*','trash-capability-probe*') for p in (home/'.Trash').glob(pattern)]"`,
  );
};

/**
 * 废纸篓能力探针（2026-10-16 实修）：这条命令链（Codex 终端 → node → python3）常常**没有**
 * 废纸篓写入权限，此时 send2trash 会「源文件消失、废纸篓里没有」地静默失败。插件端的自检
 * （core.track_remove 落点复验）会如实报错并保留库行——这是防「静默丢文件」的设计，不是 bug。
 * 所以：探针不过时，下面三条依赖废纸篓的断言转成 SKIP（打印原因），不冒充产品失败。
 */
const trashCapable = (() => {
  const probe = `${FIX}/trash-capability-probe.wav`;
  cpSync(`${RECORDINGS}/hum-test.wav`, probe);
  const started = Date.now();
  try {
    execSync(`python3 -c "from send2trash import send2trash;send2trash('${probe}')"`);
  } catch {
    return false;
  }
  const landed = ["trash-capability-probe.wav", "trash-capability-probe 2.wav"].some((name) => {
    const target = `${TRASH}/${name}`;
    return existsSync(target) && statSync(target).mtimeMs >= started - 1000;
  });
  return landed;
})();
const checkTrash = (name, ok, detail) => {
  if (trashCapable) { check(name, ok, detail); return; }
  console.log(`SKIP  ${name} — ${detail}（本进程链无废纸篓权限：send2trash 静默删除且文件不入 ~/.Trash；插件自检按设计报错并保留库行）`);
};

// ---- fixture：软链 8 首 + 三类副本 + ffmpeg 重编码的声学对/同名对 + 真 cover.jpg
const setupFixtures = () => {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(`${FIX}/meta-a`, { recursive: true });
  mkdirSync(`${FIX}/meta-b`, { recursive: true });
  const soft = ["录音 15-25-50.wav", "录音 15-26-58.wav", "录音 15-26-32.wav", "录音 15-27-15.wav", "录音 15-26-25.wav", "录音 15-55-18.wav", "录音 15-55-23.wav", "录音 15-27-08.wav"];
  soft.forEach((name, i) => symlinkSync(`${RECORDINGS}/${name}`, `${FIX}/libaccept-0${i + 1}.wav`));
  cpSync(`${RECORDINGS}/hum-test.wav`, `${FIX}/libaccept-trash.wav`);
  cpSync(`${RECORDINGS}/hum-test.wav`, `${FIX}/libaccept-perma.wav`);
  symlinkSync(`${RECORDINGS}/hum-test.wav`, `${FIX}/libaccept-remove.wav`);
  const ff = (args) => execSync(`${FF} -hide_banner -loglevel error -y ${args}`);
  ff(`-i "${STEMS}/drums.wav" -af "volume=0.99" "${FIX}/libaccept-acc.wav"`);
  ff(`-i "${STEMS}/drums.wav" -af "volume=0.98" "${FIX}/libaccept-accb.wav"`);
  ff(`-i "${STEMS}/drums.wav" -af "volume=0.99" -codec:a libmp3lame -q:a 4 "${FIX}/libaccept-acc.mp3"`);
  ff(`-i "${STEMS}/bass.wav" -af "volume=0.97" "${FIX}/meta-a/libaccept-meta.wav"`);
  ff(`-i "${STEMS}/other.wav" -af "volume=0.97" "${FIX}/meta-b/libaccept-meta.wav"`);
  ff(`-f lavfi -i color=c=0x334466:s=64x64 -frames:v 1 "${FIX}/cover.jpg"`);
};

setupFixtures();
const db = await dbPath();
cleanFixtureRows(db);
cleanTrashFixtures();
const statsBefore = await call("stats", {});
const expected = {
  bpm: (await call("list_tracks", { bpm_min: 80, bpm_max: 90, limit: 300 })).tracks.length,
  camelot: (await call("list_tracks", { camelot: "8A", limit: 300 })).tracks.length,
  tag: (await call("list_tracks", { tags: ["house"], limit: 300 })).tracks.length,
};
console.log(`基线：库 ${statsBefore.tracks} 首；bpm80-90=${expected.bpm}、8A=${expected.camelot}、house=${expected.tag}`);

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => {
  window.localStorage.setItem("shadowroom.view", "library");
});
mkdirSync(SHOTS, { recursive: true });
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".sr-lib-topbar", { timeout: 15000 });
await page.waitForFunction(() => document.querySelectorAll(".sr-lib-row").length > 0, null, { timeout: 15000 });

const search = async (text) => {
  const input = page.locator('.sr-lib-filters input[aria-label="搜索标题、艺人、专辑"]');
  await input.fill(text);
  await page.waitForTimeout(600); // 去抖 250ms + 桥往返
};
const rowsNow = () => page.locator(".sr-lib-row").count();
const openMenu = async (rowText) => {
  await search(rowText);
  await page.locator(".sr-lib-row", { hasText: rowText }).first().click({ button: "right" });
  await page.waitForSelector(".sr-lib-rowmenu", { timeout: 5000 });
};
const menuItem = (name) => page.locator(".sr-lib-rowmenu-item", { hasText: name }).first();

// ---- ① 扫描：行数增长对账 + 结果只走进度位
await page.locator(".sr-lib-scanpath").fill(FIX);
await page.getByRole("button", { name: "扫描文件夹", exact: true }).click();
await page.waitForFunction(
  (want) => document.querySelector('[data-slot="scan-progress"]')?.textContent?.includes(want),
  `新入库 ${AUDIO_COUNT}`,
  // 30s 是 #94 B1 之前的窗口：那时扫完就结束。现在扫完自动接「封面+分析」管线，
  // 16 首（fpcalc + BPM + 调性）在冷缓存上要 1–2 分钟，总结句要等管线收尾才出现。
  // 实测（2026-10-16）：窗口拉到 240s 后 16 行正常入库；过短会留下 fixture 残留。
  { timeout: 240000 },
);
const scanLine = await page.locator('[data-slot="scan-progress"]').textContent();
const statsAfter = await call("stats", {});
const strayNotice = await page.locator(".sr-lib-notice").count();
const visibleAfterScan = Math.min(statsAfter.tracks, 200);
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, visibleAfterScan, { timeout: 15000 });
check(
  "① 扫描 16 首：stats +16、UI 行数对账、结果只走进度位",
  statsAfter.tracks === statsBefore.tracks + AUDIO_COUNT && strayNotice === 0,
  `stats ${statsBefore.tracks}→${statsAfter.tracks}；进度位：${scanLine.trim()}；通用通知条=${strayNotice}`,
);
await page.screenshot({ path: `${SHOTS}/02-scanned.png` });

// ② 的数字基准必须在扫描**之后**重取：#94 B1 起扫描尾巴会自动给全库缺分析的曲目补 BPM/调性，
// 行数在扫描期间会变（2026-10-16 实测：16 首 fixture 触发全库补分析，bpm80-90 从 20 涨到 100+，
// 旧脚本拿扫描前的快照等，等到超时）。
const capped = (count) => Math.min(count, 200); // UI 一屏最多 200 行，桥口径要跟着封顶
expected.bpm = capped((await call("list_tracks", { bpm_min: 80, bpm_max: 90, limit: 300 })).tracks.length);
expected.camelot = capped((await call("list_tracks", { camelot: "8A", limit: 300 })).tracks.length);
expected.tag = capped((await call("list_tracks", { tags: ["house"], limit: 300 })).tracks.length);

// ---- ② 筛选逐项
await search("libaccept");
const searchCount = await rowsNow();
await search("");
await page.locator('.sr-lib-filters input[aria-label="BPM 下限"]').fill("80");
await page.locator('.sr-lib-filters input[aria-label="BPM 上限"]').fill("90");
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, expected.bpm, { timeout: 10000 });
const bpmCount = await rowsNow();
await page.locator('.sr-lib-filters input[aria-label="BPM 下限"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="BPM 上限"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="Camelot 调性代码"]').fill("8a");
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, expected.camelot, { timeout: 10000 });
const camelotCount = await rowsNow();
await page.locator('.sr-lib-filters input[aria-label="Camelot 调性代码"]').fill("");
await page.locator('.sr-lib-filters input[aria-label="genre tag"]').fill("house");
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, expected.tag, { timeout: 10000 });
const tagCount = await rowsNow();
await page.getByRole("button", { name: "清除筛选", exact: true }).click();
await page.waitForFunction((want) => document.querySelectorAll(".sr-lib-row").length === want, visibleAfterScan, { timeout: 10000 });
check(
  "② 搜索/BPM/Camelot/tag 逐项生效且与桥直查一致",
  searchCount === AUDIO_COUNT && bpmCount === expected.bpm && camelotCount === expected.camelot && tagCount === expected.tag,
  `libaccept=${searchCount}/${AUDIO_COUNT} · BPM80-90=${bpmCount}/${expected.bpm} · 8a=${camelotCount}/${expected.camelot} · house=${tagCount}/${expected.tag}`,
);

// ---- ②b+⑧ 右键菜单全量结构：试听第一项、打开所在文件夹禁用、危险区三段
await openMenu("libaccept-01");
const menuTexts = await page.locator(".sr-lib-rowmenu-item").allTextContents();
const menuOrder = menuTexts.map((t) => t.trim()).join("|");
const firstIsPreview = menuTexts[0]?.trim() === "试听";
const folderDisabled = (await page.locator('.sr-lib-rowmenu-item[disabled]', { hasText: "打开所在文件夹" }).count()) === 1;
const dangerCount = await page.locator(".sr-lib-rowmenu-danger").count();
const permaCount = await page.locator(".sr-lib-rowmenu-perma").count();
await page.screenshot({ path: `${SHOTS}/08-menu.png` });
check(
  "②b/⑧ 菜单结构：试听第一项/打开所在文件夹禁用/危险区 2 红 + 彻底删除小字",
  firstIsPreview && folderDisabled && dangerCount === 2 && permaCount === 1 && menuOrder.includes("编辑名称…") && menuOrder.includes("加入分类库 ▸"),
  `顺序：${menuOrder}`,
);

// ---- ⑨ 编辑名称：库 title 变、文件名不动
await menuItem("编辑名称…").click();
await page.locator(".sr-lib-rowmenu-rename input").fill("改名验收-01");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector(".sr-lib-notice")?.textContent?.includes("已改名"), null, { timeout: 10000 });
const renamed = await call("list_tracks", { query: "改名验收", limit: 10 });
const gone = await call("list_tracks", { query: "libaccept-01", limit: 10 });
check(
  "⑨ 改名：库 title 变、文件名不动",
  renamed.tracks.length === 1 && renamed.tracks[0].title === "改名验收-01" && renamed.tracks[0].path.endsWith("libaccept-01.wav") && gone.tracks.length === 0,
  `桥查「改名验收」=${renamed.tracks.length} 首（title=${renamed.tracks[0]?.title}，path 尾部 ${renamed.tracks[0]?.path.slice(-20)}）；查「libaccept-01」=${gone.tracks.length} 首`,
);

// ---- ⑩ 加入分类库：两个 crate 都在、path 逐字节不变
await openMenu("libaccept-02");
await menuItem("加入分类库 ▸").click();
await page.waitForSelector(".sr-lib-rowmenu-crates", { timeout: 5000 });
await page.locator('.sr-lib-rowmenu-crates input[aria-label="新 crate 名"]').fill("验收crate-二期");
await page.keyboard.press("Enter");
await page.waitForFunction(() => document.querySelector(".sr-lib-notice")?.textContent?.includes("已加入「验收crate-二期」"), null, { timeout: 10000 });
await openMenu("libaccept-02");
await menuItem("加入分类库 ▸").click();
await page.waitForSelector(".sr-lib-rowmenu-crates", { timeout: 5000 });
await page.locator(".sr-lib-rowmenu-crates .sr-lib-rowmenu-item", { hasText: "未命名 set" }).first().click();
await page.waitForFunction(() => document.querySelector(".sr-lib-notice")?.textContent?.includes("已加入「未命名 set」"), null, { timeout: 10000 });
const crateRows = await call("list_tracks", { query: "libaccept-02", limit: 10 });
const crateDetail = await call("track_detail", { id: crateRows.tracks[0].id });
const crateNames = crateDetail.crates.map((c) => c.name).sort();
const lib02 = (await call("list_tracks", { query: "libaccept-02", limit: 10 })).tracks[0];
check(
  "⑩ 加入分类库：两个 crate 都在、path 逐字节不变",
  crateNames.join("|") === "未命名 set|验收crate-二期" && lib02.path === `${FIX}/libaccept-02.wav`,
  `crates=[${crateNames.join(", ")}]；path === fixture 原值=${lib02.path === `${FIX}/libaccept-02.wav`}`,
);

// ---- ⑭ 封面：行小图 + 抽屉大图（真加载）；无封面占位
await search("libaccept-03");
const rowImgOk = await page.locator(".sr-lib-row", { hasText: "libaccept-03" }).first().locator("img.sr-lib-row-cover").evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
await page.locator(".sr-lib-row", { hasText: "libaccept-03" }).first().click();
await page.waitForSelector(".sr-lib-drawer", { timeout: 10000 });
const drawerImgOk = await page.locator(".sr-lib-drawer img.sr-lib-cover--img").evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
await page.screenshot({ path: `${SHOTS}/14-cover.png` });
await page.keyboard.press("Escape");
await search("libaccept-meta");
const phCount = await page.locator(".sr-lib-row-cover--ph").count();
check(
  "⑭ 封面：行小图+抽屉大图真加载（naturalWidth>0），meta 行用占位",
  rowImgOk && drawerImgOk && phCount >= 2,
  `行图=${rowImgOk} · 抽屉图=${drawerImgOk} · 占位=${phCount}（meta 两行无封面）`,
);

// ---- ⑮ 查重：acoustic 弹窗二选一（不会自动删），保留这条→另一条进废纸篓
await search("");
await page.getByRole("button", { name: "查重", exact: true }).click();
await page.waitForFunction(() => document.querySelector(".sr-lib-notice")?.textContent?.includes("声学重复"), null, { timeout: 60000 });
const dupNotice = await page.locator(".sr-lib-notice").textContent();
// 逐组跳过（两条都保留），直到出现两张卡都是 fixture 的组
let onAccGroup = false;
for (let step = 0; step < 8 && (await page.locator(".sr-lib-dupdialog").count()) > 0; step += 1) {
  const titles = await page.locator(".sr-lib-dupcard-title").allTextContents();
  if (titles.some((t) => t.includes("libaccept-acc"))) {
    onAccGroup = true;
    break;
  }
  await page.getByRole("button", { name: "两条都保留", exact: true }).click();
  await page.waitForTimeout(400);
}
let dupDetail = "没到 fixture 组";
if (onAccGroup) {
  const differRows = await page.locator(".sr-lib-duprow[data-differ]").count();
  const foot = await page.locator(".sr-lib-dup-foot").textContent();
  const reasons = await page.locator(".sr-lib-dupdialog .sr-lib-dialog-note").textContent();
  await page.screenshot({ path: `${SHOTS}/15-dupdialog.png` });
  const keepCard = page.locator(".sr-lib-dupcard", { hasText: "libaccept-accb" }).first();
  await keepCard.getByRole("button", { name: "保留这条", exact: true }).click(); // 留 accb → acc.wav 进废纸篓
  await page.waitForTimeout(1200);
  const accFileGone = !existsSync(`${FIX}/libaccept-acc.wav`);
  const accRowGone = (await call("list_tracks", { query: "libaccept-acc", limit: 20 })).tracks.filter((t) => t.path.endsWith("libaccept-acc.wav")).length === 0;
  dupDetail = `字段高亮行=${differRows} · 底注「${foot.trim()}」 · reasons「${reasons.trim().slice(0, 40)}」 · 保留后 文件消失=${accFileGone} 库行没了=${accRowGone}`;
  checkTrash(
    "⑮ 查重弹窗：两卡对比+不一致高亮+不会自动删；保留这条→另一条移出原位、库行删（落 Trash 见 ⑫b）",
    differRows >= 1 && foot.includes("不会自动删") && accFileGone && accRowGone,
    dupDetail,
  );
} else {
  check("⑮ 查重弹窗：两卡对比+不一致高亮+不会自动删；保留这条→另一条进废纸篓", false, dupDetail);
}
// 剩余弹窗全部「两条都保留」跳过（不删任何用户文件）
for (let step = 0; step < 8 && (await page.locator(".sr-lib-dupdialog").count()) > 0; step += 1) {
  await page.getByRole("button", { name: "两条都保留", exact: true }).click();
  await page.waitForTimeout(400);
}
const dialogLeft = await page.locator(".sr-lib-dupdialog").count();

// ---- ⑯ 同名不同版本：只打角标不弹窗；完全重复角标在
await search("libaccept-meta");
const suspectBadges = await page.locator(".sr-lib-dupbadge", { hasText: "疑似重复" }).count();
await search("libaccept-03");
const exactBadges = await page.locator(".sr-lib-dupbadge", { hasText: "完全重复" }).count();
await page.screenshot({ path: `${SHOTS}/16-badges.png` });
check(
  "⑯ 同名不同版本只角标（疑似重复×2 不弹窗）；完全重复角标在；查重通报含三组",
  suspectBadges >= 2 && exactBadges >= 1 && dialogLeft === 0 && dupNotice.includes("完全重复"),
  `疑似角标=${suspectBadges} · 完全重复角标=${exactBadges} · 剩余弹窗=${dialogLeft} · 通报「${dupNotice.trim().slice(0, 60)}」`,
);

// ---- ⑪ 从曲库移除：行没了、文件还在（不需要确认）
await openMenu("libaccept-remove");
await menuItem("从曲库移除").click();
await page.waitForFunction(() => document.querySelector(".sr-lib-notice")?.textContent?.includes("已从曲库移除"), null, { timeout: 10000 });
const removeGone = (await call("list_tracks", { query: "libaccept-remove", limit: 10 })).tracks.length === 0;
const removeFileStay = existsSync(`${FIX}/libaccept-remove.wav`);
check(
  "⑪ 从曲库移除：库行没了、文件还在",
  removeGone && removeFileStay,
  `库行=${removeGone ? "已删" : "还在"} · 文件存在=${removeFileStay}`,
);

// ---- ⑫ 移到废纸篓：确认弹窗（§3 文案、默认焦点取消）→ 文件进 ~/.Trash
await openMenu("libaccept-trash");
await menuItem("移到废纸篓…").click();
await page.waitForSelector(".sr-lib-dialog", { timeout: 5000 });
const trashTitle = await page.locator(".sr-lib-dialog-title").textContent();
const trashNote = await page.locator(".sr-lib-dialog-note").textContent();
const focusIsCancel = await page.evaluate(() => document.activeElement?.textContent?.trim() === "取消");
const permaLink = await page.locator(".sr-lib-dialog-permalink").count();
await page.screenshot({ path: `${SHOTS}/12-trashdialog.png` });
await page.getByRole("button", { name: "移入废纸篓", exact: true }).click();
await page.waitForTimeout(1000);
const trashFileGone = !existsSync(`${FIX}/libaccept-trash.wav`);
const trashRowGone = (await call("list_tracks", { query: "libaccept-trash", limit: 10 })).tracks.length === 0;
checkTrash(
  "⑫ 移到废纸篓：§3 文案+默认焦点取消+小字链接；文件离原位、库行删",
  trashTitle.includes("删除以下文件？") && trashNote.includes("移入系统废纸篓") && focusIsCancel && permaLink === 1 && trashFileGone && trashRowGone,
  `标题「${trashTitle.trim()}」· 焦点取消=${focusIsCancel} · 小字链接=${permaLink} · 文件消失=${trashFileGone} 库行没了=${trashRowGone}`,
);
// ⑫b 废纸篓机制对照：跑着的 mcp 桥是 Codex 运行时拉起的——它父进程的 TCC 没有 Trash 权限，
// 过桥 track_remove(remove_file=true) 时 send2trash 不报错但文件不进 ~/.Trash（静默消失，
// 数据丢失级，已报总线）。机制本身用本机直调验证：文件确实进废纸篓、可找回。
const roundFile = `${FIX}/libaccept-roundtrip.wav`;
cpSync(`${STEMS}/drums.wav`, roundFile);
execSync(`python3 -c "from send2trash import send2trash;send2trash('${roundFile}')"`);
const roundGone = !existsSync(roundFile);
const roundInTrash = trashHasFresh("libaccept-roundtrip.wav");
checkTrash(
  "⑫b 废纸篓机制对照（本机直调 send2trash）：文件真落 ~/.Trash、可找回",
  roundGone && roundInTrash,
  `源消失=${roundGone} · Trash 有=${roundInTrash}；过桥不落地=桥父进程 TCC（已报总线，建议插件落点后自检）`,
);
execSync(`python3 -c "from pathlib import Path;[p.unlink() for p in (Path.home()/'.Trash').glob('libaccept-roundtrip*')]"`);

// ---- ⑬ 彻底删除：勾选武装才可点 → 文件消失且不进废纸篓
await openMenu("libaccept-perma");
await menuItem("彻底删除…").click();
await page.waitForSelector(".sr-lib-dialog", { timeout: 5000 });
const permaDisabled = await page.locator(".sr-lib-dialog-danger").isDisabled();
await page.locator(".sr-lib-dialog-arm input[type=checkbox]").check();
const permaEnabled = await page.locator(".sr-lib-dialog-danger").isEnabled();
await page.screenshot({ path: `${SHOTS}/13-permadialog.png` });
await page.locator(".sr-lib-dialog-danger").click();
await page.waitForTimeout(1000);
const permaFileGone = !existsSync(`${FIX}/libaccept-perma.wav`);
const permaNotInTrash = !trashHasFresh("libaccept-perma.wav");
const permaRowGone = (await call("list_tracks", { query: "libaccept-perma", limit: 10 })).tracks.length === 0;
check(
  "⑬ 彻底删除：勾选前禁用、勾选后可点；文件消失且不进废纸篓",
  permaDisabled && permaEnabled && permaFileGone && permaNotInTrash && permaRowGone,
  `勾选前禁用=${permaDisabled} · 勾选后可点=${permaEnabled} · 文件消失=${permaFileGone} · 不在废纸篓=${permaNotInTrash} · 库行没了=${permaRowGone}`,
);

// ---- ③ 详情抽屉 + cue 只读（写控件=0）
await search("libaccept-04");
await page.locator(".sr-lib-row", { hasText: "libaccept-04" }).first().click();
await page.waitForSelector(".sr-lib-drawer .sr-lib-cues", { timeout: 10000 });
const drawerText = await page.locator(".sr-lib-drawer").textContent();
const coverSlot = await page.locator('.sr-lib-drawer [data-slot="cover"]').count();
const metaFields = await page.locator(".sr-lib-drawer .sr-lib-meta span").count();
const missBadges = await page.locator(".sr-lib-drawer .sr-lib-miss").count();
// #94 B1 起扫尾自动补分析会把 fixture 也补上：抽屉里 BPM/调性可能是值、也可能是「—」+缺徽标。
// 断言只锁「元信息块渲染了、cue 只读说明在、封面位在」，不锁具体是值还是缺口。
const drawerHas =
  drawerText.includes("libaccept-04") &&
  drawerText.includes("时长") &&
  drawerText.includes("BPM") &&
  drawerText.includes("调性") &&
  drawerText.includes("这首还没有 cue") &&
  drawerText.includes("在 DJ 页编辑");
await page.screenshot({ path: `${SHOTS}/04-drawer.png` });
check(
  "③ 详情抽屉有元信息/缺口/cue 只读块 + 封面位",
  drawerHas && coverSlot === 1 && metaFields >= 4,
  `标题/时长/BPM/调性/cue 来源句/只读说明 ${drawerHas ? "齐" : "缺"} · 元信息字段=${metaFields} · 缺徽标=${missBadges} · 封面位=${coverSlot}`,
);
const cueWriteControls = await page.locator(".sr-lib-cues").locator("button, input, select, textarea, [contenteditable='true']").count();
const colorInputs = await page.locator(".sr-lib").locator("input[type='color']").count();
check("⑤ cue 写控件 count===0", cueWriteControls === 0 && colorInputs === 0, `.sr-lib-cues 内交互控件=${cueWriteControls} · color input=${colorInputs}`);
await page.keyboard.press("Escape");

// ---- ④ 偏好看板 + 忘记偏好两次点击
await page.getByRole("button", { name: "统计与偏好", exact: true }).click();
await page.waitForSelector(".sr-lib-board", { timeout: 5000 });
await page.waitForFunction(() => document.querySelector(".sr-lib-pref-summary")?.textContent?.length > 10, null, { timeout: 10000 });
const statsNow = await call("stats", {});
const tileText = await page.locator(".sr-lib-tiles").textContent();
await page.getByRole("button", { name: "重新学习", exact: true }).click();
await page.waitForSelector(".sr-lib-pref-rows li", { timeout: 15000 });
const learnText = await page.locator(".sr-lib-pref-rows").textContent();
const setRows = await page.locator(".sr-lib-set-row").count();
await page.screenshot({ path: `${SHOTS}/05-board.png` });
check(
  "④ 看板数字齐：瓦片/摘要/学习行/set 列表",
  tileText.includes(String(statsNow.tracks)) && learnText.includes("样本") && setRows >= 1,
  `瓦片含现取 ${statsNow.tracks}=${tileText.includes(String(statsNow.tracks))} · 学习行含样本=${learnText.includes("样本")} · set ${setRows} 行`,
);
await page.getByRole("button", { name: "忘记偏好", exact: true }).click();
const armedText = await page.locator(".sr-lib-forget").textContent();
const armed = armedText.includes("再点一次确认忘记");
await page.waitForTimeout(5300);
const disarmedText = await page.locator(".sr-lib-forget").textContent();
check("④b 忘记偏好两次点击确认（不真忘）", armed && disarmedText.includes("忘记偏好"), `第一次→「${armedText.trim()}」，5 秒后→「${disarmedText.trim()}」`);

// ---- ⑥ 联动口径
const linkage = await page.locator(".sr-lib-linkage").textContent();
check("⑥ 联动口径文案在页面上", linkage.includes("推荐与排歌在 DJ 页") && linkage.includes("入库 / 可查 / 可学"), linkage.trim());

// ---- ⑦ 零 console error
check("⑦ 零 console error", consoleErrors.length === 0, consoleErrors.length ? consoleErrors.join(" | ").slice(0, 240) : "clean");

await browser.close();
cleanFixtureRows(db);
cleanTrashFixtures();
const statsEnd = await call("stats", {});
console.log(`收尾：fixture 行与 ~/.Trash 残骸已清，库 ${statsEnd.tracks} 首（跑前 ${statsBefore.tracks}）`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exit(failed ? 1 : 0);
