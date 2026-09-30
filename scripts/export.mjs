#!/usr/bin/env node
// dsh-playbook 导出器：run 目录 → Word(.docx) / PDF / HTML / Markdown
// Word: pandoc；PDF: 自包含 HTML（图片转 dataURI）→ wkhtmltopdf。
// 用法: export.mjs <run目录> [--formats docx,pdf,html,md] [-o outdir] [--title x]
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename, resolve, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./lib.mjs";

const has = (cmd) => {
  try { execFileSync("/bin/sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }); return true; } catch { return false; }
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const runDir = positional[0] ? resolve(positional[0]) : null;
if (!runDir) {
  console.error("用法: export.mjs <run目录> [--formats docx,pdf,html,md] [-o 输出目录]");
  process.exit(1);
}
const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
const formats = String(flags.formats || "docx,pdf").split(",").map((s) => s.trim()).filter(Boolean);
const outDir = flags.o ? resolve(isAbsolute(flags.o) ? flags.o : join(process.cwd(), flags.o)) : runDir;
mkdirSync(outDir, { recursive: true });

const base = flags.name || meta.slug;
const mdSrc = join(runDir, `${meta.slug}.md`);
if (!existsSync(mdSrc)) {
  console.error(`缺少 ${mdSrc}，请先跑 assemble.mjs`);
  process.exit(1);
}
const results = [];

// 先把当前 md 复制到输出目录（如需要 md）
if (formats.includes("md")) {
  const dest = join(outDir, `${base}.md`);
  writeFileSync(dest, readFileSync(mdSrc));
  results.push({ format: "md", path: dest });
}

// ---------- Word：pandoc ----------
if (formats.includes("docx")) {
  if (!has("pandoc")) {
    console.error("未找到 pandoc（brew install pandoc），跳过 docx");
  } else {
    const dest = join(outDir, `${base}.docx`);
    // --resource-path 让相对路径 assets/ 图片可解析
    execFileSync("pandoc", [
      mdSrc, "-f", "gfm", "-t", "docx",
      "--resource-path", runDir,
      "--toc", "--toc-depth=3",
      "-o", dest,
    ], { stdio: "inherit" });
    results.push({ format: "docx", path: dest });
  }
}

// ---------- HTML：自包含（图片内嵌 dataURI），供 PDF 与直接分发 ----------
function buildStandaloneHtml() {
  let md = readFileSync(mdSrc, "utf8");
  // 替换相对图片为 dataURI；同时兼容 markdown 图片与 <details> 内图片
  md = md.replace(/!\[([^\]]*)\]\((assets\/[^)\s]+)\)/g, (m, alt, rel) => {
    const abs = join(runDir, rel);
    if (!existsSync(abs)) return m;
    const ext = rel.split(".").pop().toLowerCase();
    const mime = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/png";
    return `![${alt}](data:${mime};base64,${readFileSync(abs).toString("base64")})`;
  });
  // 极简 markdown→html（仅本手册用到的语法）
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/&lt;((?:https?:|mailto:)[^&]+)&gt;/g, '<a href="$1">$1</a>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, href) =>
        /^data:image|^https?:|^#/.test(href) ? `<a href="${href}">${t}</a>` : t);
  const lines = md.split("\n");
  const html = [];
  let inDetails = false;
  let inList = null;
  let inQuote = false;
  const closeList = () => { if (inList) { html.push(inList === "ul" ? "</ul>" : "</ol>"); inList = null; } };
  const closeQuote = () => { if (inQuote) { html.push("</blockquote>"); inQuote = false; } };
  for (let raw of lines) {
    const line = raw;
    const det = line.match(/^<details>(?:<summary>(.*?)<\/summary>)?\s*$/);
    if (det) { closeList(); closeQuote(); html.push(`<details><summary>${inline(det[1] || "详情")}</summary>`); inDetails = true; continue; }
    if (/^<\/details>\s*$/.test(line)) { closeList(); closeQuote(); html.push("</details>"); inDetails = false; continue; }
    if (!line.trim()) { closeList(); closeQuote(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList(); closeQuote();
      html.push(`<h${m[1].length}>${inline(m[2].replace(/\s*\{#[^}]*\}/, ""))}</h${m[1].length}>`);
    } else if ((m = line.match(/^(\s*)[-*]\s+(.*)$/))) {
      closeQuote(); if (inList !== "ul") { closeList(); html.push("<ul>"); inList = "ul"; }
      const indent = Math.min(6, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
      html.push(`<li${indent ? ` style="margin-left:${indent * 14}px"` : ""}>${inline(m[2])}</li>`);
    } else if ((m = line.match(/^\s*(\d+)\.\s+(.*)$/))) {
      closeQuote(); if (inList !== "ol") { closeList(); html.push("<ol>"); inList = "ol"; }
      html.push(`<li>${inline(m[2])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      closeList(); if (!inQuote) { html.push("<blockquote>"); inQuote = true; }
      if (m[1].trim()) html.push(`<p>${inline(m[1])}</p>`);
    } else if ((m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/))) {
      closeList(); closeQuote();
      html.push(`<figure><img src="${m[2]}" alt="${esc(m[1])}"/></figure>`);
    } else if (/^---+$/.test(line)) {
      closeList(); closeQuote(); html.push("<hr/>");
    } else {
      closeList(); closeQuote();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList(); closeQuote();
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/>
<title>${esc(meta.title)}</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
body{font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Songti SC",sans-serif;color:#1f2329;font-size:12.5px;line-height:1.75;}
h1{font-size:22px;border-bottom:2px solid #2563eb;padding-bottom:8px;}
h2{font-size:17px;margin-top:26px;color:#be123c;border-left:5px solid #e11d48;padding-left:9px;}
h3{font-size:14.5px;margin-top:18px;color:#c2410c;}
h4{font-size:13.5px;margin-top:14px;color:#1d4ed8;}
blockquote{background:#f8fafc;border-left:4px solid #94a3b8;margin:8px 0;padding:6px 12px;color:#475569;font-size:12px;}
figure{margin:10px 0;text-align:center;page-break-inside:avoid;}
figure img{max-width:100%;border:1px solid #e2e8f0;border-radius:6px;}
code{background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:11.5px;}
ul,ol{padding-left:22px;} li{margin:2px 0;}
details{margin:6px 0;} summary{color:#64748b;cursor:pointer;font-size:12px;}
a{color:#2563eb;text-decoration:none;}
</style></head><body>${html.join("\n")}</body></html>`;
}

if (formats.includes("html") || formats.includes("pdf")) {
  const standalone = buildStandaloneHtml();
  const htmlPath = join(outDir, `${base}.export.html`);
  writeFileSync(htmlPath, standalone);
  if (formats.includes("html")) {
    const dest = join(outDir, `${base}.html`);
    writeFileSync(dest, standalone);
    results.push({ format: "html", path: dest });
  }
  if (formats.includes("pdf")) {
    if (!has("wkhtmltopdf")) {
      console.error("未找到 wkhtmltopdf，跳过 pdf（可用 --formats docx,html）");
    } else {
      const dest = join(outDir, `${base}.pdf`);
      execFileSync("wkhtmltopdf", [
        "--enable-local-file-access",
        "--encoding", "utf-8",
        "--margin-top", "16mm", "--margin-bottom", "16mm",
        "--margin-left", "14mm", "--margin-right", "14mm",
        "--footer-center", "[page] / [topage]", "--footer-font-size", "8",
        htmlPath, dest,
      ], { stdio: "inherit" });
      results.push({ format: "pdf", path: dest });
    }
  }
  unlinkSync(htmlPath);
}

console.log(JSON.stringify({ exported: results.map((r) => ({ format: r.format, path: r.path })) }, null, 2));
