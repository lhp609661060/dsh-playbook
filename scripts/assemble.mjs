#!/usr/bin/env node
// dsh-playbook 成文器：meta.json + steps.jsonl + assets/ → 层级化 Markdown 操作文档
// 结构：模块(## A) → 流程(### A.1) → 页面/阶段(#### A.1.1) → 步骤（全局连续编号）
// 无 section 的旧 run 自动退化为平铺（隐式节点不输出标题），100% 向后兼容。
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, basename, resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTree, numberTree, leafCount, parseArgs, parseJsonl, toAbs } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = resolve(HERE, "..");

const { positional, flags } = parseArgs(process.argv.slice(2));
const runDir = positional[0] ? resolve(positional[0]) : null;
if (!runDir) {
  console.error("用法: assemble.mjs <run目录> [-o 输出.md] [--template 路径]");
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
if (meta.pageShot) meta.pageShot = toAbs(meta.pageShot, runDir);
const { steps: allSteps, badLines } = parseJsonl(readFileSync(join(runDir, "steps.jsonl"), "utf8"));
if (badLines.length) console.error(`steps.jsonl 第 ${badLines.join("、")} 行损坏，已跳过`);
for (const s of allSteps) {
  if (s.shots?.before) s.shots.before = toAbs(s.shots.before, runDir);
  if (s.shots?.after) s.shots.after = toAbs(s.shots.after, runDir);
  if (s.file) s.file = toAbs(s.file, runDir);
}
const tree = numberTree(buildTree(allSteps));

const outputPath = flags.o
  ? resolve(isAbsolute(flags.o) ? flags.o : join(process.cwd(), flags.o))
  : join(runDir, `${meta.slug}.md`);
mkdirSync(dirname(outputPath), { recursive: true });

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

function rel(p) {
  const r = relative(dirname(outputPath), p);
  return r.startsWith("..") ? p : r;
}
function img(p) {
  return `![${basename(p)}](${rel(p).replaceAll(" ", "%20")})`;
}
const esc = (s) => String(s ?? "").trim();
const anchor = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}一-鿿 _-]/gu, "")
    .trim()
    .replaceAll(" ", "-");

function markLegend(marks) {
  if (!Array.isArray(marks) || !marks.length) return "";
  const items = marks
    .map((m, i) => `${i + 1}. **${esc(m.label)}**${m.found === false ? "（⚠️ 标注未命中，请重录）" : ""}`)
    .join("　");
  return `> 🔴 图中标注：${items}\n`;
}

function stepBlock(s) {
  const title = esc(s.title) || s.kind;
  if (s.kind === "note") {
    return `**${s._no}. ${title}**\n\n> ${esc(s.note) || "（无说明）"}\n`;
  }
  const lines = [`**${s._no}. ${title}**`, ""];
  if (s.kind === "goto" && s.url) lines.push(`访问：<${s.url}>`, "");
  if (s.kind === "fill" && s.value) lines.push(`填写内容：\`${s.value}\``, "");
  if (s.selector && process.env.PLAYBOOK_DEBUG) lines.push(`选择器：\`${s.selector}\``, "");
  if (s.note) lines.push(esc(s.note), "");
  const legend = markLegend(s.marks);
  if (legend) lines.push(legend, "");
  const before = s.shots?.before;
  const after = s.shots?.after;
  if (before) lines.push(`<details><summary>操作前</summary>\n\n${img(before)}\n\n</details>`, "");
  if (after) lines.push(img(after), "");
  if (s.kind === "attach" && s.file) {
    if (IMAGE_EXT.has(s.ext)) lines.push(img(s.file), "");
    else lines.push(`附件：[${basename(s.file)}](${rel(s.file).replaceAll(" ", "%20")})`, "");
  }
  return lines.join("\n");
}

// ---- 层级正文 ----
const explicitModules = tree.modules.filter((m) => !m.implicit);
const hierarchical = explicitModules.length > 0;

const toc = [];
const body = [];
let imageCount = meta.pageShot && existsSync(meta.pageShot) ? 1 : 0;

for (const m of tree.modules) {
  const count = leafCount(m);
  if (!m.implicit) {
    body.push(`## ${m.code} ${esc(m.title)} {#${anchor(m.code + " " + m.title)}}`, "");
    toc.push(`- [${m.code} ${esc(m.title)}](#${anchor(m.code + " " + m.title)})（${count} 步）`);
    if (m.summary) body.push(`*${esc(m.summary)}*`, "");
    if (m.note) body.push(esc(m.note), "");
  }
  for (const f of m.flows) {
    if (!f.implicit) {
      body.push(`### ${f.code} ${esc(f.title)} {#${anchor(f.code + " " + f.title)}}`, "");
      toc.push(`  - [${f.code} ${esc(f.title)}](#${anchor(f.code + " " + f.title)})`);
      if (f.summary) body.push(`*${esc(f.summary)}*`, "");
      if (f.note) body.push(esc(f.note), "");
    }
    for (const p of f.pages) {
      if (!p.implicit) {
        body.push(`#### ${p.code} ${esc(p.title)} {#${anchor(p.code + " " + p.title)}}`, "");
        toc.push(`    - [${p.code} ${esc(p.title)}](#${anchor(p.code + " " + p.title)})`);
        if (p.summary) body.push(`*${esc(p.summary)}*`, "");
        if (p.note) body.push(esc(p.note), "");
      }
      for (const s of p.children) {
        if (s.kind === "section") continue;
        if (s.appendix) continue;
        body.push(stepBlock(s));
        if (s.shots?.after) imageCount++;
        if (s.shots?.before) imageCount++;
        if (s.kind === "attach" && s.file && IMAGE_EXT.has(s.ext)) imageCount++;
      }
    }
  }
}

// ---- 附录（attach 且无插入位置的） ----
const appendix = allSteps.filter((s) => !s.dropped && s.appendix);
const appendixBlocks = [];
for (const a of appendix) {
  appendixBlocks.push(`### ${esc(a.title)}`, "");
  if (a.note) appendixBlocks.push(esc(a.note), "");
  if (a.file && IMAGE_EXT.has(a.ext)) appendixBlocks.push(img(a.file), "");
  else if (a.file) appendixBlocks.push(`附件：[${basename(a.file)}](${rel(a.file).replaceAll(" ", "%20")})`, "");
}
const appendixMd = appendixBlocks.length ? `## 附录\n\n${appendixBlocks.join("\n")}` : "";

const preamblePath = join(runDir, "preamble.md");
const preamble = existsSync(preamblePath)
  ? readFileSync(preamblePath, "utf8").trim()
  : `本文记录「${meta.title}」的完整操作流程，按模块 → 流程 → 页面分层组织，顺序执行即可复现。`;

const stepTotal = tree.modules.reduce((acc, m) => acc + leafCount(m), 0);
const tocMd = hierarchical && toc.length ? `## 目录\n\n${toc.join("\n")}\n` : "";
if (!hierarchical) body.unshift("## 操作步骤", "");

const templatePath = flags.template
  ? resolve(flags.template)
  : join(SKILL_ROOT, "templates", "playbook.md");
let md = readFileSync(templatePath, "utf8");
md = md
  .replaceAll("{{TITLE}}", meta.title)
  .replaceAll("{{URL}}", meta.url)
  .replaceAll("{{GENERATED_AT}}", new Date().toLocaleString("zh-CN", { hour12: false }))
  .replaceAll("{{STEP_COUNT}}", String(stepTotal))
  .replaceAll("{{MODULE_COUNT}}", String(explicitModules.length))
  .replaceAll("{{PREAMBLE}}", preamble)
  .replaceAll("{{TOC}}", tocMd)
  .replaceAll("{{OVERVIEW}}", meta.pageShot && existsSync(meta.pageShot) ? `## 页面概览\n\n${img(meta.pageShot)}\n` : "")
  .replaceAll("{{STEPS}}", body.join("\n"))
  .replaceAll("{{APPENDIX}}", appendixMd)
  .replace(/\n{3,}/g, "\n\n")
  .trimEnd() + "\n";

writeFileSync(outputPath, md);

if (tree.diagnostics.length) {
  for (const d of tree.diagnostics) console.error(`[${d.level}] ${d.msg}`);
}
console.log(JSON.stringify({
  output: outputPath,
  modules: explicitModules.length,
  steps: stepTotal,
  appendix: appendix.length,
  images: imageCount,
  hierarchical,
  diagnostics: tree.diagnostics,
}, null, 2));
