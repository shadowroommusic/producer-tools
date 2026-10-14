// 构建期抓取 python runtime 与 core wheels（desktop-packaging-plan.md §6.2）。
// 产物进 resources-src/（gitignore）；electron-builder 的 extraResources 从那里装进 .app。
// 用法：node scripts/fetch-runtime.mjs   （重复运行幂等：已存在且 build-id 相同就跳过）
//
// 为什么运行时版本是 3.12 而不是 3.13：torch 2.2.2 没有 cp313 wheel（本档 §6.2 实查），
// 而 3.12 是 soundfont 现役版本、numpy 1.26.4 / 全部 pins 都有 cp312 arm64 wheel。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const SRC = join(ROOT, "resources-src");
const spec = JSON.parse(readFileSync(join(ROOT, "wheels-core.json"), "utf8"));

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} -> exit ${r.status}`);
  return r;
}

mkdirSync(SRC, { recursive: true });

// 1) pbs runtime：下载 → 解包（顶层目录名固定是 python/）→ 落位 python-runtime/
const runtimeDir = join(SRC, "python-runtime");
const buildIdFile = join(runtimeDir, ".build-id");
if (existsSync(buildIdFile) && readFileSync(buildIdFile, "utf8").trim() === spec.runtime) {
  console.log(`[fetch] runtime already present: ${spec.runtime}`);
} else {
  rmSync(runtimeDir, { recursive: true, force: true });
  rmSync(join(SRC, "python"), { recursive: true, force: true });
  const tgz = join(SRC, "pbs.tar.gz");
  console.log(`[fetch] downloading ${spec.runtime} ...`);
  sh("/usr/bin/curl", ["-fL", "--retry", "3", "-o", tgz, spec.runtimeUrl]);
  sh("/usr/bin/tar", ["-xzf", tgz, "-C", SRC]);
  // pbs install_only 的顶层目录固定叫 python/；改名立build-id，ENV_STAMP 用它判断升级重建
  const extracted = join(SRC, "python");
  if (!existsSync(extracted)) throw new Error("pbs tarball did not extract to python/");
  mkdirSync(join(extracted, ".tmp"), { recursive: true });
  sh("/bin/mv", [extracted, runtimeDir]);
  rmSync(join(SRC, "pbs.tar.gz"), { force: true });
  writeFileSync(buildIdFile, spec.runtime);
  console.log(`[fetch] runtime ok: ${spec.runtime}`);
}

// 2) core wheels：用 runtime 自带的 pip 直接解析+下载完整依赖闭包（含 sqlalchemy/construct
//    等 pyrekordbox 连带），解析器是 pip 本身，不手抄依赖树（不猜原则）。
const wheelsDir = join(SRC, "wheels", "core");
const stampFile = join(wheelsDir, ".fetch-stamp");
const stampWant = createHash("sha256").update(spec.pins.join("|") + spec.runtime).digest("hex");
if (existsSync(stampFile) && readFileSync(stampFile, "utf8").trim() === stampWant) {
  console.log(`[fetch] wheels already present (${readdirSync(wheelsDir).filter(f => f.endsWith(".whl")).length} whl)`);
} else {
  rmSync(wheelsDir, { recursive: true, force: true });
  mkdirSync(wheelsDir, { recursive: true });
  const py = join(runtimeDir, "bin", "python3");
  sh(py, ["-m", "pip", "download", "--quiet", "-d", wheelsDir, ...spec.pins]);
  writeFileSync(stampFile, stampWant);
}

// 2b) soundfont 档（§6.4 第 3 步）：wheels 走 pip；fluidsynth dylib 闭包用 otool -L 从
//     dylibSource（本机 conda venv 的 lib/，42M+ 全量）递归抽出非系统的 @rpath 依赖，
//     cp -L 解引用（conda 的 soname 是符号链，版本化真身必须一起进来）。
//     抽出的闭包直接并入 python-runtime/lib/：runtime python 的 LC_RPATH 指向那里，
//     venv python（符号链到真身）dlopen 裸名与 @rpath 依赖都命中——不碰 DYLD 全局变量。
const soundfont = JSON.parse(readFileSync(join(ROOT, "wheels-soundfont.json"), "utf8"));
const sfWheelsDir = join(SRC, "wheels", "soundfont");
const sfStamp = join(sfWheelsDir, ".fetch-stamp");
const sfWant = createHash("sha256")
  .update(soundfont.pins.join("|") + spec.runtime + soundfont.dylibSource + soundfont.dylibSeeds.join(","))
  .digest("hex");
if (existsSync(sfStamp) && readFileSync(sfStamp, "utf8").trim() === sfWant
    // 闭包完成的凭据是 DYLIBS.txt（stamp 在全部成功后才写；runtime 重建会连 lib 一起清空）
    && existsSync(join(sfWheelsDir, "DYLIBS.txt"))
    && existsSync(join(runtimeDir, "lib", soundfont.dylibSeeds[0]))) {
  console.log(`[fetch] soundfont wheels already present (${readdirSync(sfWheelsDir).filter(f => f.endsWith(".whl")).length} whl)`);
} else {
  rmSync(sfWheelsDir, { recursive: true, force: true });
  mkdirSync(sfWheelsDir, { recursive: true });
  const py = join(runtimeDir, "bin", "python3");
  sh(py, ["-m", "pip", "download", "--quiet", "-d", sfWheelsDir, ...soundfont.pins]);

  // dylib 闭包：种子是 fluidsynth 的 soname；宽度优先收齐非系统 @rpath 依赖。
  const srcLib = soundfont.dylibSource;
  if (!existsSync(srcLib)) throw new Error(`dylibSource 不存在：${srcLib}（构建机需要有 soundfont 的 conda venv）`);
  const copied = new Map(); // name -> bytes（去重统计）
  const queue = [...soundfont.dylibSeeds];
  const isSystem = (dep) => dep.startsWith("/usr/lib/") || dep.startsWith("/System/");
  for (let round = 0; queue.length > 0 && round < 200; round += 1) {
    const name = queue.shift();
    if (copied.has(name)) continue;
    const dst = join(runtimeDir, "lib", name);
    sh("/bin/cp", ["-L", join(srcLib, name), dst]);
    copied.set(name, statSync(dst).size);
    const otool = spawnSync("/usr/bin/otool", ["-L", dst], { encoding: "utf8" });
    if (otool.status !== 0) throw new Error(`otool -L ${dst} failed`);
    for (const line of otool.stdout.split("\n").slice(1)) {
      const dep = line.trim().split(" ")[0];
      if (dep.startsWith("@rpath/") && !isSystem(dep)) {
        const base = dep.slice("@rpath/".length);
        if (!copied.has(base) && existsSync(join(srcLib, base))) queue.push(base);
      }
    }
  }
  const total = [...copied.values()].reduce((a, b) => a + b, 0);
  console.log(`[fetch] fluidsynth dylib closure: ${copied.size} files, ${(total / 1024 / 1024).toFixed(2)} MB -> python-runtime/lib/`);
  if (total > 20 * 1024 * 1024) throw new Error(`dylib closure ${(total / 1024 / 1024).toFixed(1)}MB 超过 20M 红线（§6.2：超线改首用下载，不许随包）`);
  writeFileSync(join(sfWheelsDir, "DYLIBS.txt"),
    `${[...copied.keys()].sort().join("\n")}\nTotal: ${total} bytes\n`);
  writeFileSync(sfStamp, sfWant);
}

// 3) 清单（验收 ③ 对账用：名字 + 大小 + sha256）
const lines = [];
for (const f of readdirSync(wheelsDir).filter((f) => f.endsWith(".whl")).sort()) {
  const buf = readFileSync(join(wheelsDir, f));
  lines.push(`${f}\t${buf.length}\t${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
}
writeFileSync(join(wheelsDir, "MANIFEST.txt"), `${spec.runtime}\n${lines.join("\n")}\n`);
console.log(`[fetch] wheels manifest:\n${lines.map((l) => "  " + l.split("\t")[0]).join("\n")}`);
