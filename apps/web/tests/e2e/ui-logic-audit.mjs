/**
 * 全应用 UI 逻辑巡检器（_bus/artifacts/2026-10-16-ui-and-call-queue.md §③，--task ui-logic-audit）。
 *
 * 像用户一样把每个页面走一遍：收集所有可见 button/[role=button]/a，逐个安全点击，
 * 记录 console error / pageerror、点击前后 DOM 签名（无变化 = 死按钮候选）、出现的弹层能否关上、
 * 焦点去向。截图落 exports/ui-audit/<page>-<n>.png，报告落 _bus/artifacts/2026-10-16-ui-logic-audit.md。
 *
 * 安全设计（验收条款「不产生对用户数据的写入」）：
 * ① 黑名单按钮只记录不点击：删除/移入废纸篓/彻底删除/退出/清空/忘记/重置/卸载，另加 新建工程/新工程；
 * ② 每页用全新浏览器 context（临时档案）：localStorage 写入不落用户真实浏览器；
 * ③ 网络全罐头：/api/** 一律本地应答（不走真桥、不花真模型钱、不落盘），非本源请求一律空 200——
 *    点击任何按钮都不可能产生对用户数据/外部服务的真实副作用。
 * 方法学边界（写进报告）：网络被罐头后，依赖桥数据的按钮按「UI 逻辑」口径评估（点击有反馈/报可读错
 * 即算活），不代表真桥联通性；死按钮为 DOM 签名启发式候选，供人工复核。
 *
 * 前置：5173 dev server。用法：node tests/e2e/ui-logic-audit.mjs（HEADFUL=1 可有头观察）。
 */
import { chromium } from "/Users/lazora/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";
import { mkdirSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const BASE = process.env.UI_AUDIT_BASE ?? "http://localhost:5173";
const REPO = "/Users/lazora/Documents/ShadowRoom";
const SHOTS = `${REPO}/exports/ui-audit`;
const REPORT = `${REPO}/_bus/artifacts/2026-10-16-ui-logic-audit.md`;

/** 规格点名的页面（§③ 列了 7 个名字，全走；plugin 是 plugins 的子页不入列）。 */
const PAGES = [
  { id: "workbench", label: "工作台" },
  { id: "conversation", label: "对话" },
  { id: "studio", label: "Studio" },
  { id: "dj", label: "DJ" },
  { id: "library", label: "曲目库" },
  { id: "settings", label: "设置" },
  { id: "plugins", label: "插件" },
];

/** 黑名单：只记录不点击（§③ 原词 + 用户补的「不新建工程」）。 */
const BLACKLIST = /删除|废纸篓|彻底删除|退出|清空|忘记|重置|卸载|新建工程|新工程/;

const BUTTON_SEL = "button, [role=button], a";
/** 弹层候选：原生 dialog、菜单背板、常见命名。误报由「尝试关闭后仍在」复检兜底。 */
const OVERLAY_SEL = [
  "dialog[open]",
  "[role=dialog]",
  ".sr-menu-backdrop",
  "[class*='modal' i]",
  "[class*='backdrop' i]",
  "[class*='overlay' i]",
  "[class*='popover' i]",
  "[class*='dropdown' i]",
].join(", ");

const MAX_CLICKS_PER_PAGE = 80; // 安全阀：同名只点首个，单页超过即停
const SETTLE_MS = 450; // 点击后等 React 提交 + notice 动画

/**
 * 源码复核注记（第一轮巡检后逐个对着 src 读过，写死进脚本保证报告可复现）：
 * 把「死按钮候选」里的环境伪影/合法无操作和真疑点分开，避免主审误读。
 */
const REVIEW_NOTES = {
  "studio/从磁盘选取…":
    "罐头网络伪影：按钮唯一效果是 POST /api/agent/pick 后按返回 paths 落轨（StudioPage:1482 pickAndImport），罐头 {ok:true} 无 paths → 静默返回。真桥下会弹选择器，需真桥复核。",
  "library/重新学习":
    "有反馈（哈希签名测到 DOM 变化：busy 闪动 + 结果区更新；第一轮长度签名曾漏检）。注意罐头 /api/call 下学习结果为空态文案，真桥数字需真桥复核。",
  "dj/新建 set":
    "合法无操作：draft 永非空（DJPage:261 useState<Draft>(readDraft)），进入页时已是全新空 draft，再点一次重置无可见变化；用户改过 draft 后点击会可见重置（DJPage:371 newSet）。",
  "mic:NotAllowedError":
    "环境路径：headless 拒绝 getUserMedia → 语音输入/开始通话 抛未处理 rejection（pageerror）。真实用户拒绝麦克风权限走同一路径：按钮自身有 DOM 反馈，但无「没拿到麦克风」的可读提示——记为可改进项而非阻断。",
};

/** /api/** 罐头应答表（形状对着 src/lib/*.ts 的解析点；未列出的走通用 {"ok":true}，全部 .json() 带兜底）。 */
const canned = (path) => {
  if (path.startsWith("/api/agent/send")) return { status: 200, contentType: "text/event-stream", body: "" };
  if (path.startsWith("/api/agent/media-events")) return { status: 200, body: '{"events":[],"next":0}' };
  if (path.startsWith("/api/agent/dir")) return { status: 200, body: '{"entries":[]}' };
  if (path.startsWith("/api/agent/models"))
    return {
      status: 200,
      body: JSON.stringify({
        models: [{
          id: "audit-mock", displayName: "Audit Mock", description: "ui-logic-audit 罐头模型", isDefault: true,
          supportedReasoningEfforts: [{ effort: "medium", description: "" }],
        }],
      }),
    };
  if (path.startsWith("/api/agent/health"))
    return { status: 200, body: '{"ok":true,"threads":1,"cwd":"/tmp/ui-audit","sandbox":"none"}' };
  if (path.startsWith("/api/servers"))
    return {
      status: 200,
      body: JSON.stringify({
        servers: [{ id: "audit-mock", label: "Audit Mock 插件", description: "罐头", connected: true, tools: [] }],
        home: "/tmp/ui-audit", workspaces: "/tmp/ui-audit",
      }),
    };
  if (path.startsWith("/api/agent/credentials")) return { status: 200, body: '{"credentials":[]}' };
  return { status: 200, body: '{"ok":true}' };
};

const now = () => new Date().toISOString().slice(11, 19);
const log = (msg) => console.log(`${now()}  ${msg}`);

/**
 * 页内 DOM 签名：outerHTML 哈希 × 交互元素数 × 可见弹层数 × 正文哈希。用真哈希不用长度——
 * 长度签名会被等长互换骗过（实测：标准/极简 两个 mode 按钮的 data-on 互换 -8/+8 净零）。
 */
async function domSignature(page) {
  return page.evaluate((sel) => {
    const hash = (input) => {
      let h = 5381;
      for (let i = 0; i < input.length; i += 1) h = ((h << 5) + h + input.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };
    const interactive = document.querySelectorAll("button,a,[role=button]").length;
    const overlays = [...document.querySelectorAll(sel)]
      .filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && (el.checkVisibility?.() ?? true);
      }).length;
    return `${hash(document.documentElement.outerHTML)}.${interactive}.${overlays}.${hash(document.body.innerText)}`;
  }, OVERLAY_SEL);
}

async function accessibleName(locator) {
  const raw = await locator.evaluate((el) => {
    const label = el.getAttribute("aria-label") ?? "";
    const title = el.getAttribute("title") ?? "";
    const text = (el.innerText ?? el.textContent ?? "").trim();
    return (label || text || title).replace(/\s+/g, " ").trim();
  }).catch(() => "");
  return raw.slice(0, 48) || "(无名)";
}

/** 收集当前页所有可见可点元素：{key, name, tag, disabled}。同名+同标签只取首个（去重记数）。 */
async function collectButtons(page) {
  const count = await page.locator(BUTTON_SEL).count();
  const seen = new Map();
  const list = [];
  for (let i = 0; i < count; i += 1) {
    const locator = page.locator(BUTTON_SEL).nth(i);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => "?");
    const name = await accessibleName(locator);
    const disabled = await locator.isDisabled().catch(() => false)
      || (await locator.getAttribute("aria-disabled").catch(() => null)) === "true";
    const key = `${tag}:${name}`;
    if (seen.has(key)) { seen.get(key).duplicates += 1; continue; }
    const entry = { key, name, tag, disabled, duplicates: 0 };
    seen.set(key, entry);
    list.push(entry);
  }
  return list;
}

/** 当前可见弹层描述（找最新一个）。 */
async function visibleOverlay(page) {
  const count = await page.locator(OVERLAY_SEL).count();
  for (let i = count - 1; i >= 0; i -= 1) {
    const locator = page.locator(OVERLAY_SEL).nth(i);
    if (!(await locator.isVisible().catch(() => false))) continue;
    const box = await locator.boundingBox().catch(() => null);
    if (box === null || box.width === 0 || box.height === 0) continue;
    const name = await accessibleName(locator);
    return { locator, name };
  }
  return null;
}

/** 依次尝试：Esc → 点背板 → 点关闭钮。返回 {closed, how}。 */
async function tryCloseOverlay(page, overlay) {
  const stillThere = async () => {
    const current = await visibleOverlay(page);
    return current !== null && current.name === overlay.name;
  };
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
  if (!(await stillThere())) return { closed: true, how: "Esc" };
  await overlay.locator.click({ position: { x: 4, y: 4 }, force: true }).catch(() => {});
  await page.waitForTimeout(250);
  if (!(await stillThere())) return { closed: true, how: "点背板" };
  const closers = overlay.locator(
    "[aria-label*='关闭' i], [aria-label*='收起' i], [title*='关闭' i], button:has-text('关闭'), button:has-text('收起'), button:has-text('取消'), button:has-text('×')",
  );
  if ((await closers.count()) > 0) {
    await closers.first().click().catch(() => {});
    await page.waitForTimeout(250);
    if (!(await stillThere())) return { closed: true, how: "关闭钮" };
  }
  return { closed: false, how: "Esc/背板/关闭钮均关不掉" };
}

const portBusy = (port) => {
  const probe = spawnSync("sh", ["-c", `lsof -nP -iTCP:${port} -sTCP:LISTEN | tail -1`], { encoding: "utf8" });
  return probe.stdout.trim().length > 0;
};
if (!portBusy(5173) && !process.env.UI_AUDIT_BASE) {
  console.log("FAIL  环境 — 5173 dev server 不在（先 pnpm dev，或 UI_AUDIT_BASE 覆写）");
  process.exit(1);
}

mkdirSync(SHOTS, { recursive: true });
for (const file of readdirSync(SHOTS)) if (file.endsWith(".png")) rmSync(`${SHOTS}/${file}`);

// 假麦克风（MiniMax 审计 O-7）：不给这两个 flag 时 headless 拒绝 getUserMedia，
// 每页都冒 1-2 条 NotAllowedError，11 条固定噪声会淹没真的 console error。
const browser = await chromium.launch({
  channel: "chrome",
  headless: process.env.HEADFUL === undefined,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});
const audit = []; // {page, rows: [{name, tag, result, evidence, duplicates}], errors: [], badOverlays: []}

for (const { id: pageId, label } of PAGES) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // 全罐头网络：/api/** 本地应答；非本源一律空 200（零外部副作用）。本源放行走 vite 资源。
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) {
      const path = new URL(url).pathname;
      if (path.startsWith("/api/")) {
        const c = canned(path);
        return route.fulfill({ status: c.status, contentType: c.contentType ?? "application/json", body: c.body });
      }
      return route.continue();
    }
    return route.fulfill({ status: 200, contentType: "text/plain", body: "" });
  });

  // 每次导航重播种：巡检视角 = 每页「进入时」的干净状态；Studio 给最小工程让轨道/检视器可巡。
  await page.addInitScript((view) => {
    window.localStorage.setItem("shadowroom.view", view);
    window.localStorage.setItem("shadowroom.studio.projects.v1", JSON.stringify({
      projects: [{
        id: "proj-ui-audit", name: "UI 巡检", updatedAt: 1, bpm: 120, key: "", bars: 16,
        tracks: [
          { id: "trk-1", name: "和声", muted: false, soloed: false, volume: 80, clips: [] },
          { id: "trk-2", name: "鼓", muted: false, soloed: false, volume: 80, clips: [] },
        ],
      }],
    }));
    window.localStorage.setItem("shadowroom.studio.open", "proj-ui-audit");
    window.localStorage.removeItem("shadowroom.orb.position");
  }, pageId);

  const consoleErrors = [];
  let lastClick = "(进入页面)";
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push({ at: lastClick, text: msg.text().slice(0, 160) });
  });
  page.on("pageerror", (error) => {
    consoleErrors.push({ at: lastClick, text: `pageerror: ${String(error).slice(0, 160)}` });
  });

  const rows = [];
  const badOverlays = [];
  let shotSeq = 0;
  const shot = async (suffix) => {
    shotSeq += 1;
    const path = `${SHOTS}/${pageId}-${String(shotSeq).padStart(2, "0")}-${suffix}.png`;
    await page.screenshot({ path }).catch(() => {});
    return path;
  };

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1600);
  await shot("进入");

  const visited = new Set();
  let clicks = 0;
  let guard = 0;
  while (clicks < MAX_CLICKS_PER_PAGE && guard < MAX_CLICKS_PER_PAGE * 3) {
    guard += 1;
    const buttons = await collectButtons(page);
    const next = buttons.find((b) => !visited.has(b.key));
    if (next === undefined) break;
    visited.add(next.key);

    if (next.disabled) {
      rows.push({ name: next.name, tag: next.tag, result: "禁用", evidence: "disabled/aria-disabled，未点击", duplicates: next.duplicates, note: undefined });
      continue;
    }
    if (BLACKLIST.test(next.name)) {
      rows.push({ name: next.name, tag: next.tag, result: "黑名单只记不点", evidence: `命中 ${BLACKLIST.source}，未点击`, duplicates: next.duplicates, note: undefined });
      continue;
    }

    // 重新定位到当前 DOM 里的同名首个（列表可能已因前次点击变化）
    const tagSel = next.tag === "a" ? "a" : next.tag === "button" ? "button" : "[role=button]";
    const target = page.locator(`${tagSel}`).filter({ hasText: next.name }).first();
    const byAria = await page.locator(`${tagSel}[aria-label="${next.name.replace(/"/g, '\\"')}"]`).count();
    const locator = (await target.count()) > 0 && (await target.isVisible().catch(() => false))
      ? target
      : byAria > 0 ? page.locator(`${tagSel}[aria-label="${next.name.replace(/"/g, '\\"')}"]`).first()
      : null;
    if (locator === null) {
      rows.push({ name: next.name, tag: next.tag, result: "收集后消失", evidence: "点击前已不在 DOM/不可见（前序点击改变了列表）", duplicates: next.duplicates, note: undefined });
      continue;
    }

    clicks += 1;
    lastClick = `${next.name}#${clicks}`;
    // 已选中态（aria-pressed/data-on/aria-checked 的激活段）：点自身常是合法无操作，单独归类
    const selectedState = await locator
      .evaluate((el) => el.matches('[aria-pressed="true"], [data-on], [aria-checked="true"]'))
      .catch(() => false);
    const before = await domSignature(page);
    const errorsBefore = consoleErrors.length;
    await locator.click({ timeout: 4000 }).catch((e) => {
      consoleErrors.push({ at: lastClick, text: `点击失败: ${String(e).slice(0, 120)}` });
    });
    await page.waitForTimeout(SETTLE_MS);
    const after = await domSignature(page);

    // 弹层：出现了就试着关（Esc → 背板 → 关闭钮），关不掉记 bad + 截图取证
    let overlayNote = "";
    const overlay = await visibleOverlay(page);
    if (overlay !== null) {
      const evidenceShot = await shot(`弹层-${overlay.name.slice(0, 12)}`);
      const { closed, how } = await tryCloseOverlay(page, overlay);
      overlayNote = closed
        ? `弹层「${overlay.name}」出现，可关（${how}）`
        : `弹层「${overlay.name}」关不掉（Esc/背板/关闭钮均无效）`;
      if (!closed) {
        badOverlays.push({ trigger: next.name, overlay: overlay.name, evidence: evidenceShot });
        await shot(`弹层关不掉-${overlay.name.slice(0, 12)}`);
      }
    }

    // 导航型点击：视图被切走 → goto 回本页（init script 会重播种干净状态），本按钮记「导航」
    const viewNow = await page.evaluate(() => window.localStorage.getItem("shadowroom.view")).catch(() => pageId);
    let navNote = "";
    if (viewNow !== pageId) {
      navNote = `导航 → ${viewNow}（回本页续巡，状态已重置）`;
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);
    }

    const focusAfter = await page.evaluate(() => {
      const el = document.activeElement;
      if (el === null || el === document.body) return "body";
      return `${el.tagName.toLowerCase()}${el.getAttribute("aria-label") ? `[${el.getAttribute("aria-label")}]` : ""}`;
    }).catch(() => "?");

    const newErrors = consoleErrors.slice(errorsBefore).map((e) => e.text);
    const domChanged = before !== after;
    const note = REVIEW_NOTES[`${pageId}/${next.name}`];
    const result = navNote !== ""
      ? "导航"
      : !domChanged && overlayNote === "" && newErrors.length === 0
        ? selectedState ? "已选中态（无变化，正常）" : "死按钮候选"
        : "已点击";
    const evidenceBits = [
      domChanged ? "DOM 签名变化" : "DOM 签名无变化",
      overlayNote,
      navNote,
      newErrors.length > 0 ? `console error ×${newErrors.length}` : "",
      overlayNote !== "" && focusAfter === "body" ? "弹层开着但焦点在 body" : "",
    ].filter(Boolean);
    rows.push({ name: next.name, tag: next.tag, result, evidence: evidenceBits.join("；") || "—", duplicates: next.duplicates, note });
  }

  audit.push({ id: pageId, label, rows, consoleErrors, badOverlays, clicks });
  const dead = rows.filter((r) => r.result === "死按钮候选").map((r) => r.name);
  log(`${label}(${pageId})：点击 ${clicks}，按钮 ${rows.length}，死按钮候选 ${dead.length}${dead.length ? ` [${dead.join("、")}]` : ""}，console error ${consoleErrors.length}，关不掉弹层 ${badOverlays.length}`);
  await context.close();
}
await browser.close();

// ================= 报告 =================
const deadAll = [];
const selectedAll = [];
const blackAll = [];
const errorTotal = [];
const overlayTotal = [];
let buttonTotal = 0;
let clickTotal = 0;
const pageSections = audit.map(({ id, label, rows, consoleErrors, badOverlays, clicks }) => {
  buttonTotal += rows.length;
  clickTotal += clicks;
  rows.filter((r) => r.result === "死按钮候选").forEach((r) => deadAll.push(`${label}/${r.name}`));
  rows.filter((r) => r.result === "已选中态（无变化，正常）").forEach((r) => selectedAll.push(`${label}/${r.name}`));
  rows.filter((r) => r.result === "黑名单只记不点").forEach((r) => blackAll.push(`${label}/${r.name}`));
  consoleErrors.forEach((e) => errorTotal.push(`${label}（点「${e.at}」时）：${e.text}`));
  badOverlays.forEach((o) => overlayTotal.push(`${label}：「${o.trigger}」弹出的「${o.overlay}」关不掉（${o.evidence}）`));
  const table = rows.map((r, i) => `| ${i + 1} | ${r.name}${r.duplicates > 0 ? `（+${r.duplicates} 同名）` : ""} | ${r.tag} | ${r.result} | ${r.evidence}${r.note ? `。**复核**：${r.note}` : ""} |`).join("\n");
  const errLines = consoleErrors.length
    ? `\n\n**console error（${consoleErrors.length}）**：\n${consoleErrors.map((e) => `- 点「${e.at}」时：${e.text}${e.text.includes("NotAllowedError") ? `。**复核**：${REVIEW_NOTES["mic:NotAllowedError"]}` : ""}`).join("\n")}`
    : "\n\n**console error**：无";
  const overlayLines = badOverlays.length
    ? `\n\n**关不掉的弹层（${badOverlays.length}）**：\n${badOverlays.map((o) => `- 「${o.trigger}」→「${o.overlay}」，证据 ${o.evidence}`).join("\n")}`
    : "\n\n**关不掉的弹层**：无";
  return `## ${label}（${id}）—— ${rows.length} 个按钮（同名去重后），实点 ${clicks} 次\n\n| # | 按钮 | 元素 | 结果 | 证据 |\n| --- | --- | --- | --- | --- |\n${table}${errLines}${overlayLines}`;
});

const deadNotes = {};
audit.forEach(({ id, label, rows }) => {
  rows.forEach((r) => {
    const note = REVIEW_NOTES[`${id}/${r.name}`];
    if (note !== undefined) deadNotes[`${label}/${r.name}`] = note;
  });
});
const deadReviewed = deadAll.filter((entry) => deadNotes[entry] !== undefined);
const deadNeedsHuman = deadAll.filter((entry) => deadNotes[entry] === undefined);
const reviewedLines = deadReviewed.map((entry) => `- ${entry} — ${deadNotes[entry]}`);

const report = `# 全应用 UI 逻辑巡检 · 第一轮（ui-logic-audit）

脚本 \`apps/web/tests/e2e/ui-logic-audit.mjs\`（可重复跑：\`node tests/e2e/ui-logic-audit.mjs\`，前置 5173 dev server）。
截图目录 \`exports/ui-audit/\`。巡检时间 ${new Date().toISOString()}。

## 方法与边界（读表前必看）

- **安全设计**：黑名单按钮（删除/移入废纸篓/彻底删除/退出/清空/忘记/重置/卸载/新建工程）只记录不点击；
  每页独立全新浏览器 context（临时档案，localStorage 不落用户真实浏览器）；\`/api/**\` 全部本地罐头应答、
  非本源请求一律空 200——点击任何按钮都不产生对用户数据或外部服务的真实写入。
- **死按钮候选是启发式**：口径 = 点击前后 DOM 签名（结构长度×交互元素数×可见弹层数×正文长度）无变化、
  且无弹层、无 console error。音频类按钮（播放/试听）若无 DOM 反馈会落入此列，需人工复核。
- **网络为罐头**：依赖桥数据的按钮（导出/发送/扫描等）只评估 UI 逻辑（点击有反馈或报可读错 = 活），
  不代表真桥联通性；「导航」= 按钮切走了视图，属正常行为，回本页重置后续巡。
- 同名按钮只点首个（其余记 +N 同名）；单页安全阀 80 次点击。

## 总数字

- 页面 × 按钮：**${audit.length} 页 × ${buttonTotal} 个按钮**（同名去重后），实际点击 ${clickTotal} 次
- 死按钮候选：**${deadAll.length}**（复核定性见下）
  - 已复核定性（${deadReviewed.length}）——罐头网络伪影 / 合法无操作，非阻断：
${reviewedLines.map((l) => `  ${l}`).join("\n") || "  - （无）"}
  - 需人工复核（${deadNeedsHuman.length}）：
${deadNeedsHuman.map((l) => `  - ${l}`).join("\n") || "  - 无"}
- 已选中态无变化（点激活段无操作，正常）：**${selectedAll.length}**${selectedAll.length ? `\n  - ${selectedAll.join("\n  - ")}` : ""}
- 黑名单（只记不点）：**${blackAll.length}**${blackAll.length ? `\n  - ${blackAll.join("\n  - ")}` : ""}
- console error / pageerror：**${errorTotal.length}**（其中麦克风权限 NotAllowedError ×${errorTotal.filter((e) => e.includes("NotAllowedError")).length}，复核注记见下）${errorTotal.length ? `\n  - ${errorTotal.join("\n  - ")}` : ""}
- 关不掉的弹层：**${overlayTotal.length}**${overlayTotal.length ? `\n  - ${overlayTotal.join("\n  - ")}` : ""}

${pageSections.join("\n\n---\n\n")}
`;
writeFileSync(REPORT, report);
console.log(`\nREPORT  ${REPORT}`);
console.log(`SUMMARY  pages=${audit.length} buttons=${buttonTotal} clicks=${clickTotal} dead=${deadAll.length} blacklist=${blackAll.length} consoleErrors=${errorTotal.length} badOverlays=${overlayTotal.length}`);
process.exit(0);
