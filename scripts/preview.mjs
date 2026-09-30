#!/usr/bin/env node
// dsh-playbook 预览器：run 目录 → 单文件交互式「思维导图 / 业务流程」HTML。
// 用法: preview.mjs <run目录> [-o out.html] [--no-embed] [--mermaid out.mmd] [--json out.json]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, resolve, dirname, relative, isAbsolute } from "node:path";
import { buildTree, numberTree, buildIndex, toMermaid, parseArgs, parseJsonl, toAbs } from "./lib.mjs";
const mkdirSafe = (p) => { try { mkdirSync(p, { recursive: true }); } catch { /* exists */ } };

const { positional, flags } = parseArgs(process.argv.slice(2));
const runDir = positional[0] ? resolve(positional[0]) : null;
if (!runDir) {
  console.error("用法: preview.mjs <run目录> [-o out.html] [--no-embed] [--mermaid x.mmd] [--json x.json]");
  process.exit(1);
}

const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
if (meta.pageShot) meta.pageShot = toAbs(meta.pageShot, runDir);
const { steps, badLines } = parseJsonl(readFileSync(join(runDir, "steps.jsonl"), "utf8"));
if (badLines.length) console.error(`steps.jsonl 第 ${badLines.join("、")} 行损坏，已跳过`);
for (const s of steps) {
  if (s.shots?.before) s.shots.before = toAbs(s.shots.before, runDir);
  if (s.shots?.after) s.shots.after = toAbs(s.shots.after, runDir);
  if (s.file) s.file = toAbs(s.file, runDir);
}
const tree = numberTree(buildTree(steps));
// --no-embed：图片用相对路径引用（单文件分发必须内嵌，故 --no-embed 时强制要求 -o 到 run 目录内）
const embed = !flags["no-embed"] && flags.embed !== false;
if (!embed && !flags.o) {
  console.error("--no-embed 必须配合 -o 指定输出到 run 目录内的 html（否则相对图片路径无法解析）");
  process.exit(1);
}

const imgData = (absPath) => {
  if (!absPath || !existsSync(absPath)) return null;
  if (embed) {
    const ext = absPath.split(".").pop().toLowerCase();
    const mime = ext === "jpg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : "image/png";
    return `data:${mime};base64,${readFileSync(absPath).toString("base64")}`;
  }
  const outPath = flags.o ? resolve(isAbsolute(flags.o) ? flags.o : join(process.cwd(), flags.o)) : join(runDir, `${meta.slug}.preview.html`);
  return relative(dirname(outPath), absPath).replaceAll(" ", "%20");
};

const escapeHtml = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const KIND_LABEL = {
  goto: "导航", click: "点击", fill: "填写", scroll: "滚动",
  eval: "页面操作", shot: "截图", note: "说明", attach: "附件",
};

// 序列化叶子（只带渲染需要的字段，图片转 dataURI/相对路径）
function serLeaf(s) {
  return {
    id: s.id,
    no: s._no,
    kind: s.kind,
    kindLabel: KIND_LABEL[s.kind] || s.kind,
    title: s.title || s.kind,
    note: s.note || "",
    url: s.url || "",
    selector: s.selector || "",
    value: s.value || "",
    code: s.codeField || s.code || "",
    marks: (s.marks || []).map((m) => ({ label: m.label, color: m.color, found: m.found !== false, selector: m.selector })),
    images: {
      after: imgData(s.shots?.after),
      before: imgData(s.shots?.before),
    },
  };
}

const data = {
  title: meta.title,
  url: meta.url,
  generatedAt: new Date().toLocaleString("zh-CN", { hour12: false }),
  pageShot: imgData(meta.pageShot),
  modules: tree.modules.map((m) => ({
    id: m.id || 0,
    code: m.code,
    title: m.title,
    implicit: !!m.implicit,
    summary: m.summary || "",
    note: m.note || "",
    flows: m.flows.map((f) => ({
      id: f.id || 0,
      code: f.code,
      title: f.title,
      implicit: !!f.implicit,
      summary: f.summary || "",
      note: f.note || "",
      pages: f.pages.map((p) => ({
        id: p.id || 0,
        code: p.code,
        title: p.title,
        implicit: !!p.implicit,
        summary: p.summary || "",
        note: p.note || "",
        steps: p.children.filter((s) => s.kind !== "section").map(serLeaf),
      })),
    })),
  })),
};

const mmd = toMermaid(tree, meta);
// 默认落到内部目录 .playbook-internal/（思维导图是 AI 推理/用户预览的辅助产物，不进交付包）
const internalDir = join(runDir, ".playbook-internal");
const outputPath = flags.o
  ? resolve(isAbsolute(flags.o) ? flags.o : join(process.cwd(), flags.o))
  : join(internalDir, `${meta.slug}.preview.html`);
if (!flags.o) mkdirSafe(internalDir);

if (flags.mermaid) {
  const mp = flags.mermaid === true ? join(internalDir, `${meta.slug}.mmd`) : resolve(flags.mermaid);
  mkdirSafe(dirname(mp));
  writeFileSync(mp, mmd);
}
if (flags.json) {
  const jp = flags.json === true ? join(internalDir, `${meta.slug}.index.json`) : resolve(flags.json);
  mkdirSafe(dirname(jp));
  writeFileSync(jp, JSON.stringify(buildIndex(tree), null, 2));
}

// ---------- HTML ----------
const jsonForScript = JSON.stringify({ ...data, mermaid: mmd }).replaceAll("</", "<\\/");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${data.title} · 操作手册预览</title>
<style>
  :root{
    --bg:#f6f7f9; --panel:#fff; --ink:#1f2329; --sub:#646a73; --line:#dfe1e6;
    --brand:#2563eb; --brand-bg:#eff4ff; --warn:#b45309;
    --c1:#e11d48; --c2:#ea580c; --c3:#2563eb; --c4:#16a34a; --c5:#9333ea; --c6:#0891b2; --c7:#ca8a04;
    --radius:10px;
  }
  *{box-sizing:border-box}
  body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--ink)}
  header{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:12px 20px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;flex:1;min-width:240px}
  header h1 small{color:var(--sub);font-weight:400;margin-left:8px;font-size:12px}
  .tabs{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
  .tabs button{border:0;background:#fff;padding:6px 14px;cursor:pointer;font-size:13px;color:var(--sub)}
  .tabs button.on{background:var(--brand);color:#fff}
  select,input[type=search]{border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px;background:#fff;color:var(--ink)}
  .btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:6px 12px;font-size:13px;cursor:pointer;color:var(--ink)}
  .btn:hover{border-color:var(--brand);color:var(--brand)}
  main{padding:20px;max-width:1180px;margin:0 auto}
  .hint{color:var(--sub);font-size:12px;margin:4px 0 16px}
  /* ---- 思维导图 ---- */
  .map{overflow-x:auto;padding-bottom:24px}
  .node{margin:2px 0}
  .node-children{margin-left:26px;border-left:1px dashed var(--line);padding-left:16px}
  .node-row{display:flex;align-items:center;gap:8px;padding:5px 10px;border-radius:8px;cursor:default;background:var(--panel);border:1px solid var(--line);width:fit-content;max-width:760px}
  .node-row.clickable{cursor:pointer}
  .node-row.clickable:hover{border-color:var(--brand);box-shadow:0 1px 6px rgba(37,99,235,.12)}
  .twist{width:16px;color:var(--sub);cursor:pointer;user-select:none;text-align:center;flex:none}
  .code{font-weight:700;font-size:12px;border-radius:5px;padding:1px 7px;flex:none}
  .lv1 .code{background:var(--c1);color:#fff}
  .lv2 .code{background:var(--c2);color:#fff}
  .lv3 .code{background:var(--c3);color:#fff}
  .lv1>.node-row{font-size:15px;font-weight:700;background:#fff5f6;border-color:#fecdd3}
  .lv2>.node-row{font-weight:600;background:#fff7ed;border-color:#fed7aa}
  .lv3>.node-row{background:var(--brand-bg);border-color:#bfdbfe}
  .node-title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .summary{color:var(--sub);font-weight:400;font-size:12px;margin-left:6px}
  .implicit{opacity:.55;font-style:italic}
  .leaf .node-row{background:#fff}
  .leaf .no{font-size:12px;font-weight:700;color:var(--brand);min-width:26px;text-align:right;flex:none}
  .badge{font-size:11px;padding:0 6px;border-radius:10px;background:#eef0f3;color:var(--sub);flex:none}
  .badge.mark{background:#fef2f2;color:var(--c1)}
  .badge.implicit{background:#f3f4f6}
  .count{font-size:11px;color:var(--sub);flex:none}
  .add-mini{font-size:11px;color:var(--brand);border:1px dashed #bfdbfe;background:#fff;border-radius:6px;padding:0 8px;cursor:pointer;flex:none}
  .add-mini:hover{background:var(--brand-bg)}
  mark{background:#fef08a;border-radius:2px;padding:0 1px}
  /* ---- 流程视图 ---- */
  .flow-module{background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);margin-bottom:18px;overflow:hidden}
  .flow-module>h2{margin:0;padding:12px 16px;font-size:15px;background:linear-gradient(90deg,#fff5f6,#fff);border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:baseline}
  .flow-module .m-summary{color:var(--sub);font-size:12px;font-weight:400}
  .flow-lane{padding:8px 16px 14px;border-bottom:1px dashed var(--line)}
  .flow-lane:last-child{border-bottom:0}
  .flow-lane>h3{margin:8px 0;font-size:13px;color:var(--c2);display:flex;gap:8px;align-items:baseline}
  .flow-lane>h3 .f-summary{color:var(--sub);font-weight:400;font-size:12px}
  .page-block{margin:6px 0 6px 10px;padding-left:14px;border-left:2px solid #bfdbfe}
  .page-block>h4{margin:8px 0 4px;font-size:13px;color:var(--brand);font-weight:600}
  .step-card{display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border:1px solid var(--line);border-radius:8px;margin:6px 0;cursor:pointer;background:#fff}
  .step-card:hover{border-color:var(--brand)}
  .step-card .no{font-weight:700;color:var(--brand);font-size:12px;min-width:28px;text-align:right}
  .step-card .t{flex:1}
  .step-card .t .sub{color:var(--sub);font-size:12px;display:block}
  /* ---- 详情抽屉 ---- */
  .mask{position:fixed;inset:0;background:rgba(15,23,42,.4);z-index:40;display:none}
  .mask.on{display:block}
  .drawer{position:fixed;top:0;right:0;height:100%;width:min(640px,92vw);background:#fff;z-index:41;transform:translateX(100%);transition:transform .18s ease;display:flex;flex-direction:column;box-shadow:-8px 0 30px rgba(0,0,0,.12)}
  .drawer.on{transform:translateX(0)}
  .drawer header{position:static;display:block;border:0;border-bottom:1px solid var(--line);padding:16px 18px}
  .drawer header h2{margin:0 0 4px;font-size:16px}
  .drawer .body{flex:1;overflow-y:auto;padding:16px 18px}
  .drawer .body img{width:100%;border:1px solid var(--line);border-radius:8px;margin:8px 0;cursor:zoom-in;background:#fafafa}
  .drawer .body h5{margin:14px 0 6px;font-size:12px;color:var(--sub);text-transform:uppercase;letter-spacing:.05em}
  .drawer pre{background:#f6f7f9;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
  .legend{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
  .legend span{font-size:12px;border-radius:10px;padding:1px 9px;color:#fff}
  .kv{font-size:12px;color:var(--sub);margin:2px 0}
  .kv code{background:#f6f7f9;padding:1px 5px;border-radius:4px;color:var(--ink)}
  .actions{display:flex;gap:8px;padding:12px 18px;border-top:1px solid var(--line);background:#fafbfc}
  .actions .btn{flex:1;text-align:center}
  .toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:#111827;color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;z-index:60;opacity:0;transition:opacity .2s;pointer-events:none}
  .toast.on{opacity:.94}
  /* ---- 大图 ---- */
  .lightbox{position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:50;display:none;align-items:center;justify-content:center;padding:24px}
  .lightbox.on{display:flex}
  .lightbox img{max-width:100%;max-height:100%;border-radius:6px}
  @media (max-width:640px){.summary{display:none}header h1 small{display:none}}
</style>
</head>
<body>
<header>
  <h1>${escapeHtml(data.title)}<small>${escapeHtml(data.url || "")}</small></h1>
  <div class="tabs">
    <button id="tab-map" class="on">思维导图</button>
    <button id="tab-flow">业务流程</button>
  </div>
  <select id="depth" title="展开层级">
    <option value="4">全部展开（含操作）</option>
    <option value="3">展开到页面/阶段</option>
    <option value="2">展开到流程</option>
    <option value="1">只看模块</option>
  </select>
  <input type="search" id="q" placeholder="搜索标题 / 说明…" style="width:170px"/>
  <button class="btn" id="copy-mm">复制 Mermaid</button>
</header>
<main>
  <div class="hint">点击节点标题查看详情（配图/选择器/标注）；点 <b>＋</b> 可折叠。每个节点都能一键生成「让 AI 补充 / 修改」的口令，粘贴回聊天即可——改动后重跑本预览，AI 只对改动子树做局部推理、再跑一次全局快速校验。</div>
  <div id="view-map" class="map"></div>
  <div id="view-flow" style="display:none"></div>
</main>
<div class="mask" id="mask"></div>
<aside class="drawer" id="drawer">
  <header><h2 id="d-title"></h2><div id="d-sub" class="kv"></div></header>
  <div class="body" id="d-body"></div>
  <div class="actions" id="d-actions"></div>
</aside>
<div class="lightbox" id="lightbox"><img id="lightbox-img" alt=""/></div>
<div class="toast" id="toast"></div>
<script>
const DATA = ${jsonForScript};
let leavesById = {};
DATA.modules.forEach(m => m.flows.forEach(f => f.pages.forEach(p => p.steps.forEach(s => leavesById[s.id] = s))));

const $ = (sel) => document.querySelector(sel);
function el(tag, cls, text){ const e = document.createElement(tag); if(cls) e.className = cls; if(text!=null) e.textContent = text; return e; }
function esc(s){ return String(s ?? "").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function escHtml(s){ return esc(s); }
function toast(msg){ const t = $("#toast"); t.textContent = msg; t.classList.add("on"); setTimeout(()=>t.classList.remove("on"), 1800); }
function copy(text, ok){ navigator.clipboard?.writeText(text).then(()=>toast(ok||"已复制，粘贴到聊天即可")).catch(()=>toast("复制失败，请手动选择")); }

let nodeSeq = 0;
function leafPath(s){
  for (const m of DATA.modules) for (const f of m.flows) for (const p of f.pages)
    if (p.steps.some(x => x.id === s.id)) return m.title + " / " + f.title + " / " + p.title;
  return "";
}
function promptFor(node, verb){
  if (node.t === "leaf"){
    const s = node.s;
    const base = "[dsh-playbook 步骤 #" + s.id + "「" + s.title + "」（" + leafPath(s) + "）]";
    return verb === "edit"
      ? base + " 请修改：（在这里写要改的标题/说明/截图/标注；如需重拍请把页面停到对应状态）"
      : base + " 请在此步骤后补充内容：（说明要补的说明步骤、截图或红框标注）";
  }
  const kind = node.t === "module" ? "模块" : node.t === "flow" ? "流程" : "页面/阶段";
  const action = verb === "add" ? "新增" : "调整";
  return "[dsh-playbook " + kind + " " + node.code + "「" + node.title + "」] 请在该" + kind + "下" + action + "：\\n- 要" + action + "的流程/页面/操作步骤：\\n- 文档说明要点：\\n（如需录制新操作，请把浏览器停到对应页面）";
}

// ---------- 思维导图 ----------
function buildMap(){
  const root = $("#view-map"); root.innerHTML = "";
  DATA.modules.forEach(m => root.appendChild(sectionNode(m, "module", "lv1")));
  applyDepth();
}
function sectionNode(o, type, cls){
  const node = el("div", "node " + cls);
  const row = el("div", "node-row clickable");
  const twist = el("span", "twist", "－");
  const code = el("span", "code", o.code || "");
  const title = el("span", "node-title", o.title);
  row.append(twist, code, title);
  if (o.implicit) { const b = el("span","badge implicit","隐式"); row.appendChild(b); }
  if (o.summary) row.appendChild(el("span", "summary", "— " + o.summary));
  let nLeaves = 0;
  const children = el("div", "node-children");
  if (type === "module"){
    o.flows.forEach(f => children.appendChild(sectionNode(f, "flow", "lv2")));
    nLeaves = countLeaves(o, "module");
  } else if (type === "flow"){
    o.pages.forEach(p => children.appendChild(sectionNode(p, "page", "lv3")));
    nLeaves = o.pages.reduce((a,p)=>a+p.steps.length,0);
  } else {
    o.steps.forEach(s => children.appendChild(leafNode(s)));
    nLeaves = o.steps.length;
  }
  if (o.note) children.appendChild(noteLine(o.note));
  const addBtn = el("button", "add-mini", "＋ 加节点");
  addBtn.title = "生成「让 AI 在此节点下新增内容」的口令";
  addBtn.onclick = (e) => { e.stopPropagation(); copy(promptFor({t:type, code:o.code, title:o.title}, "add")); };
  row.appendChild(el("span","count", nLeaves + " 步"));
  row.appendChild(addBtn);
  row.onclick = () => openSection(type, o);
  twist.onclick = (e) => { e.stopPropagation(); toggleNode(node, twist); };
  node.append(row, children);
  return node;
}
function countLeaves(o, type){
  if (type === "module") return o.flows.reduce((a,f)=>a+f.pages.reduce((b,p)=>b+p.steps.length,0),0);
  return 0;
}
function noteLine(text){ const d = el("div","hint"); d.style.margin = "4px 0 6px"; d.textContent = "📝 " + text; return d; }
function leafNode(s){
  const node = el("div", "node leaf");
  const row = el("div", "node-row clickable");
  row.dataset.id = s.id;
  row.append(el("span","no", String(s.no)), el("span","node-title", s.title), el("span","badge", s.kindLabel));
  if (s.marks.length) row.appendChild(el("span","badge mark","标注×" + s.marks.length));
  row.onclick = () => openLeaf(s);
  node.appendChild(row);
  return node;
}
function toggleNode(node, twist){
  const children = node.querySelector(":scope > .node-children");
  const hidden = children.style.display === "none";
  children.style.display = hidden ? "" : "none";
  twist.textContent = hidden ? "－" : "＋";
}
function applyDepth(){
  const d = Number($("#depth").value);
  document.querySelectorAll("#view-map .node").forEach(n => {
    const isLv1 = n.classList.contains("lv1"), isLv2 = n.classList.contains("lv2"), isLv3 = n.classList.contains("lv3");
    const lvl = isLv1?1:isLv2?2:isLv3?3:4;
    const c = n.querySelector(":scope > .node-children");
    if (!c) return;
    const twist = n.querySelector(":scope > .node-row > .twist");
    const hide = lvl >= d;
    c.style.display = hide ? "none" : "";
    if (twist) twist.textContent = hide ? "＋" : "－";
  });
}
$("#depth").onchange = applyDepth;

// 搜索：命中标题/说明的叶子高亮并展开祖先
$("#q").oninput = () => {
  const q = $("#q").value.trim().toLowerCase();
  document.querySelectorAll("#view-map .node-row").forEach(r => r.style.background = "");
  if (!q){ buildMap(); return; }
  // 全部展开
  document.querySelectorAll("#view-map .node-children").forEach(c => c.style.display = "");
  document.querySelectorAll("#view-map .twist").forEach(t => t.textContent = "－");
  document.querySelectorAll("#view-map .leaf").forEach(leafDiv => {
    const row = leafDiv.querySelector(":scope > .node-row");
    const s = leavesById[row.dataset.id];
    const hit = s && (s.title.toLowerCase().includes(q) || s.note.toLowerCase().includes(q));
    if (hit){
      row.style.background = "#fef9c3";
      row.querySelector(".node-title").innerHTML = highlight(s.title, q);
    }
  });
  document.querySelectorAll("#view-map .node.lv1,#view-map .node.lv2,#view-map .node.lv3").forEach(n => {
    const hit = n.textContent.toLowerCase().includes(q);
    if (hit) n.querySelector(":scope > .node-row").style.background = "#dbeafe";
  });
};
function highlight(text, q){
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0,i)) + "<mark>" + esc(text.slice(i,i+q.length)) + "</mark>" + esc(text.slice(i+q.length));
}

// ---------- 业务流程视图 ----------
function buildFlow(){
  const root = $("#view-flow"); root.innerHTML = "";
  DATA.modules.forEach(m => {
    const card = el("section","flow-module");
    const h = el("h2"); h.append(el("span","code", m.code||""), document.createTextNode(m.title + " "));
    if (m.summary) h.appendChild(el("span","m-summary","— " + m.summary));
    card.appendChild(h);
    if (m.note) card.appendChild(p(m.note));
    m.flows.forEach(f => {
      const lane = el("div","flow-lane");
      const h3 = el("h3"); h3.append(el("span","code", f.code||""), document.createTextNode(f.title));
      if (f.summary) h3.appendChild(el("span","f-summary","— " + f.summary));
      lane.appendChild(h3);
      if (f.note) lane.appendChild(p(f.note));
      f.pages.forEach(pg => {
        const pb = el("div","page-block");
        pb.appendChild(el("h4", "", pg.code + " " + pg.title));
        if (pg.summary) pb.appendChild(p(pg.summary, true));
        pg.steps.forEach(s => {
          const c = el("div","step-card");
          c.appendChild(el("span","no", String(s.no)));
          const t = el("div","t");
          t.append(document.createTextNode(s.title + " "), el("span","badge", s.kindLabel));
          if (s.marks.length) t.appendChild(el("span","badge mark"," 标注×"+s.marks.length));
          if (s.note) t.appendChild(el("span","sub", s.note.slice(0, 90) + (s.note.length>90?"…":"")));
          c.appendChild(t);
          c.onclick = () => openLeaf(s);
          pb.appendChild(c);
        });
        lane.appendChild(pb);
      });
      card.appendChild(lane);
    });
    root.appendChild(card);
  });
}
function p(text, sub){ const e = el("p", sub?"m-summary":"hint"); e.textContent = text; e.style.margin = "4px 0"; return e; }

// ---------- 详情抽屉 ----------
function openSection(type, o){
  $("#d-title").textContent = o.code + " " + o.title;
  $("#d-sub").textContent = ({module:"模块",flow:"业务流程",page:"页面 / 阶段"})[type] + (o.implicit ? "（系统隐式节点，可在录制时用 section 显式声明）" : "");
  const body = $("#d-body"); body.innerHTML = "";
  if (o.summary) body.appendChild(sec("概述", o.summary));
  if (o.note) body.appendChild(sec("说明", o.note));
  body.appendChild(sec("结构", type === "module"
    ? "含 " + o.flows.length + " 个流程，" + countLeaves(o,"module") + " 个操作步骤"
    : type === "flow"
      ? "含 " + o.pages.length + " 个页面/阶段，" + o.pages.reduce((a,x)=>a+x.steps.length,0) + " 个操作步骤"
      : "含 " + o.steps.length + " 个操作步骤"));
  const acts = $("#d-actions"); acts.innerHTML = "";
  const b1 = el("button","btn","＋ 让 AI 在此节点下补充");
  b1.onclick = () => copy(promptFor({t:type, code:o.code, title:o.title}, "add"));
  const b2 = el("button","btn","✎ 让 AI 修改此节点");
  b2.onclick = () => copy(promptFor({t:type, code:o.code, title:o.title}, "edit"));
  acts.append(b1,b2);
  showDrawer();
}
function sec(h, text){ const f = document.createDocumentFragment(); f.appendChild(el("h5","",h)); const e = el("div","",text); f.appendChild(e); return f; }
function openLeaf(s){
  $("#d-title").textContent = s.no + ". " + s.title;
  $("#d-sub").textContent = s.kindLabel + " · 步骤 #" + s.id + " · " + leafPath(s);
  const body = $("#d-body"); body.innerHTML = "";
  if (s.note) body.appendChild(sec("操作说明", s.note));
  if (s.marks.length){
    body.appendChild(el("h5","","标注"));
    const lg = el("div","legend");
    s.marks.forEach(m => {
      const x = el("span", "", (m.found?"● ":"○ ") + m.label);
      x.style.background = m.color;
      lg.appendChild(x);
    });
    body.appendChild(lg);
  }
  if (s.images.before){ body.appendChild(el("h5","","操作前")); body.appendChild(img(s.images.before)); }
  if (s.images.after){ body.appendChild(el("h5","","操作后 / 标注图")); body.appendChild(img(s.images.after)); }
  const tech = [];
  if (s.url) tech.push("URL：<code>" + esc(s.url) + "</code>");
  if (s.selector) tech.push("选择器：<code>" + esc(s.selector) + "</code>");
  if (s.value) tech.push("填写值：<code>" + esc(s.value) + "</code>");
  if (s.code) tech.push("页面脚本：");
  if (tech.length){ body.appendChild(el("h5","","录制信息")); tech.forEach(t => { const d=el("div","kv"); d.innerHTML=t; body.appendChild(d); }); }
  if (s.code){ const pre = el("pre","",s.code); body.appendChild(pre); }
  const acts = $("#d-actions"); acts.innerHTML = "";
  const b1 = el("button","btn","✎ 让 AI 修改这步");
  b1.onclick = () => copy(promptFor({t:"leaf", s}, "edit"));
  const b2 = el("button","btn","＋ 在后面补充");
  b2.onclick = () => copy(promptFor({t:"leaf", s}, "add"));
  acts.append(b1,b2);
  showDrawer();
}
function img(src){ const i = document.createElement("img"); i.src = src; i.onclick = () => { $("#lightbox-img").src = src; $("#lightbox").classList.add("on"); }; return i; }
function showDrawer(){ $("#drawer").classList.add("on"); $("#mask").classList.add("on"); }
function closeDrawer(){ $("#drawer").classList.remove("on"); $("#mask").classList.remove("on"); }
$("#mask").onclick = closeDrawer;
$("#lightbox").onclick = () => $("#lightbox").classList.remove("on");

$("#tab-map").onclick = () => switchTab("map");
$("#tab-flow").onclick = () => switchTab("flow");
function switchTab(t){
  $("#tab-map").classList.toggle("on", t==="map");
  $("#tab-flow").classList.toggle("on", t==="flow");
  $("#view-map").style.display = t==="map"?"":"none";
  $("#view-flow").style.display = t==="flow"?"":"none";
  closeDrawer();
  if (t==="flow") buildFlow(); else buildMap();
}
$("#copy-mm").onclick = () => copy(DATA.mermaid, "Mermaid mindmap 已复制，可贴到支持 mermaid 的编辑器");

buildMap();
</script>
</body>
</html>`;

writeFileSync(outputPath, html);
const totalLeaves = data.modules.reduce(
  (a, m) => a + m.flows.reduce((b, f) => b + f.pages.reduce((c, p) => c + p.steps.length, 0), 0),
  0,
);
console.log(JSON.stringify({
  output: outputPath,
  modules: data.modules.length,
  flows: data.modules.reduce((a, m) => a + m.flows.length, 0),
  steps: totalLeaves,
  diagnostics: tree.diagnostics,
  sizeMB: +(Buffer.byteLength(html) / 1048576).toFixed(2),
}, null, 2));
