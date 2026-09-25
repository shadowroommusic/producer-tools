// 构建期抓取 python runtime 与 core wheels（desktop-packaging-plan.md §6.2）。
// 产物进 resources-src/（gitignore）；electron-builder 的 extraResources 从那里装进 .app。
// 用法：node scripts/fetch-runtime.mjs   （重复运行幂等：已存在且 build-id 相同就跳过）
//
// 为什么运行时版本是 3.12 而不是 3.13：torch 2.2.2 没有 cp313 wheel（本档 §6.2 实查），
// 而 3.12 是 soundfont 现役版本、numpy 1.26.4 / 全部 pins 都有 cp312 arm64 wheel。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

// 3) 清单（验收 ③ 对账用：名字 + 大小 + sha256）
const lines = [];
for (const f of readdirSync(wheelsDir).filter((f) => f.endsWith(".whl")).sort()) {
  const buf = readFileSync(join(wheelsDir, f));
  lines.push(`${f}\t${buf.length}\t${createHash("sha256").update(buf).digest("hex").slice(0, 16)}`);
}
writeFileSync(join(wheelsDir, "MANIFEST.txt"), `${spec.runtime}\n${lines.join("\n")}\n`);
console.log(`[fetch] wheels manifest:\n${lines.map((l) => "  " + l.split("\t")[0]).join("\n")}`);
