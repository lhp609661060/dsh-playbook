#!/usr/bin/env node
// dsh-playbook 录制器
// 用法见 SKILL.md。所有状态落在 run 目录；浏览器动作走 webbridge.mjs。
import { mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join, basename, resolve, isAbsolute } from "node:path";
import * as wb from "./webbridge.mjs";
import {
  buildTree, numberTree, outlineText, parseArgs, parseJsonl,
  toPortable, toAbs, portableMigrate, PAGE_JS_HELPERS,
} from "./lib.mjs";
import { loadRegistry, saveRegistry, regTouch, regAttachDoc } from "./registry.mjs";

const parseFlags = (argv) => parseArgs(argv, { repeatKeys: ["mark"] });

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/https?:\/\//, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `run-${Date.now()}`;
}

function findRunDir(explicit) {
  if (explicit) return resolve(explicit);
  // 从 cwd 向上找最近的含 steps.jsonl 的目录
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "steps.jsonl")) && existsSync(join(dir, "meta.json"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function loadRun(dir) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  if (meta.pageShot) meta.pageShot = toAbs(meta.pageShot, dir);
  const { steps, badLines } = parseJsonl(readFileSync(join(dir, "steps.jsonl"), "utf8"));
  if (badLines.length) {
    process.stderr.write(`playbook: steps.jsonl 第 ${badLines.join("、")} 行损坏，已跳过（建议手工修复）\n`);
  }
  for (const s of steps) {
    if (s.shots?.before) s.shots.before = toAbs(s.shots.before, dir);
    if (s.shots?.after) s.shots.after = toAbs(s.shots.after, dir);
    if (s.file) s.file = toAbs(s.file, dir);
  }
  return { meta, steps };
}

function saveSteps(dir, steps) {
  // 落盘统一转相对 run 目录，保证 run 目录可整体搬迁/打包
  const portable = steps.map((s) => {
    const c = { ...s };
    if (c.shots) c.shots = {
      ...(c.shots.before ? { before: toPortable(c.shots.before, dir) } : {}),
      ...(c.shots.after ? { after: toPortable(c.shots.after, dir) } : {}),
    };
    if (c.file) c.file = toPortable(c.file, dir);
    return c;
  });
  const tmp = join(dir, "steps.jsonl.tmp");
  writeFileSync(tmp, portable.map((s) => JSON.stringify(s)).join("\n") + "\n");
  writeFileSync(join(dir, "steps.jsonl"), readFileSync(tmp)); // 原子替换
}

function saveMeta(dir, meta) {
  const out = { ...meta };
  if (out.pageShot) out.pageShot = toPortable(out.pageShot, dir);
  writeFileSync(join(dir, "meta.json"), JSON.stringify(out, null, 2) + "\n");
}

function out(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function fail(msg) {
  process.stderr.write(`playbook: ${msg}\n`);
  process.exit(1);
}

// ---------- 截图 ----------
function shotPath(dir, stepNo, suffix) {
  return join(dir, "assets", `shot-${String(stepNo).padStart(3, "0")}${suffix}.png`);
}

async function takeShot(dir, meta, stepNo, suffix, retries = 0) {
  const path = shotPath(dir, stepNo, suffix);
  try {
    await wb.screenshot(path, meta.session);
    regTouch(dir, path);
    return path;
  } catch (err) {
    if (retries < 2) {
      await new Promise((r) => setTimeout(r, 600));
      return takeShot(dir, meta, stepNo, suffix, retries + 1);
    }
    throw new Error(`截图失败（${stepNo}${suffix}）: ${err.message}。若 webbridge 提示标签页不可见，请在浏览器中切到任务标签页后 reshoot。`);
  }
}

// ---------- 元素红框标注（页面内注入 overlay，截进真实截图） ----------
const MARK_COLORS = ["#e11d48", "#ea580c", "#2563eb", "#16a34a", "#9333ea", "#0891b2", "#ca8a04"];

// 把 ["css选择器|标签", "text=登录|登录按钮"] 解析成 {selector, label}
function parseMarks(list) {
  return list
    .flatMap((x) => String(x).split(";;"))
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((item, i) => {
      const [sel, ...rest] = item.split("|");
      const label = rest.join("|").trim();
      return { selector: sel.trim(), label: label || `标记${i + 1}`, color: MARK_COLORS[i % MARK_COLORS.length] };
    });
}

// 注入/重绘 overlay。spec: [{selector,label,color}]，返回每个标记的命中与坐标
async function injectMarks(meta, specs) {
  const payload = JSON.stringify(specs);
  const code = `(() => {
    ${PAGE_JS_HELPERS}
    const specs = ${payload};
    const old = document.getElementById('__pb_marks');
    if (old) old.remove();
    const isVisible = pbIsVisible;
    const resolve = pbResolve;
    // 标注前把表格类内部横向滚动归零（固定列 + 横向偏移会让框错位）
    document.querySelectorAll('.el-table__body-wrapper, .el-scrollbar__wrap').forEach((w) => { try { w.scrollLeft = 0; } catch { /* noop */ } });
    // 只做纵向居中，绝不改变横向滚动位置
    const resolved = specs.map((sp) => ({ ...sp, el: resolve(sp.selector) }));
    const bringVertical = (el) => {
      const r0 = el.getBoundingClientRect();
      const vh = document.documentElement.clientHeight;
      if (r0.top >= 0 && r0.bottom <= vh) return;
      let node = el.parentElement, done = false;
      while (node) {
        const oy = getComputedStyle(node).overflowY;
        if (node.scrollHeight > node.clientHeight && (oy === 'auto' || oy === 'scroll')) {
          const er = el.getBoundingClientRect(); const nr = node.getBoundingClientRect();
          node.scrollTop += er.top - nr.top - nr.height / 2 + er.height / 2;
          done = true; break;
        }
        node = node.parentElement;
      }
      if (!done) window.scrollBy({ top: r0.top - vh / 2, behavior: 'instant' });
    };
    for (const r of resolved) if (r.el) bringVertical(r.el);
    const layer = document.createElement('div');
    layer.id = '__pb_marks';
    layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
    // 顶部图例条：数字 + 完整标签，避免相邻元素的标签互相重叠
    const legend = document.createElement('div');
    legend.style.cssText = 'position:fixed;top:8px;left:50%;transform:translateX(-50%);display:flex;flex-wrap:wrap;gap:6px;justify-content:center;max-width:94vw;';
    const vw = () => document.documentElement.clientWidth;
    const vh = () => document.documentElement.clientHeight;
    const out = [];
    resolved.forEach((r, i) => {
      const chip = document.createElement('span');
      chip.textContent = (i + 1) + ' ' + r.label;
      chip.style.cssText = 'background:rgba(17,24,39,.88);color:#fff;font:600 12px/1.5 -apple-system,"PingFang SC",sans-serif;padding:1px 10px;border-radius:12px;white-space:nowrap;max-width:46%;overflow:hidden;text-overflow:ellipsis;border-left:4px solid ' + r.color;
      legend.appendChild(chip);
      if (!r.el) { out.push({ ...r, el: undefined, found: false }); return; }
      const rect = r.el.getBoundingClientRect();
      const inView = rect.top >= -2 && rect.left >= -2 && rect.bottom <= vh() + 2 && rect.right <= vw() + 2;
      const box = document.createElement('div');
      box.style.cssText = 'position:fixed;box-sizing:border-box;border:3px solid ' + r.color +
        ';border-radius:4px;box-shadow:0 0 0 2px rgba(255,255,255,.85);left:' + (rect.left - 3) + 'px;top:' +
        (rect.top - 3) + 'px;width:' + (rect.width + 6) + 'px;height:' + (rect.height + 6) + 'px;';
      layer.appendChild(box);
      // 数字角标（圆圈），压在框左上角
      const badge = document.createElement('div');
      badge.textContent = String(i + 1);
      badge.style.cssText = 'position:fixed;left:' + Math.max(2, rect.left - 12) + 'px;top:' +
        Math.max(2, rect.top - 12) + 'px;width:22px;height:22px;border-radius:50%;background:' + r.color +
        ';color:#fff;font:700 12px/22px -apple-system,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff;';
      layer.appendChild(badge);
      out.push({ selector: r.selector, label: r.label, color: r.color, found: true, inView,
        box: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) } });
    });
    layer.appendChild(legend);
    document.body.appendChild(layer);
    return out;
  })()`;
  const res = await wb.evalJs(code, meta.session);
  return res?.value ?? res;
}

async function clearMarks(meta) {
  try {
    await wb.evalJs(`(()=>{const o=document.getElementById('__pb_marks');if(o)o.remove();return 'cleared';})()`, meta.session);
  } catch {
    /* 页面跳转后 overlay 自然消失 */
  }
}

// ---------- 页面文档识别（DOM 优先，零视觉 token） ----------
// 浏览器截图的内容本来就在 DOM 里：直接抽取标题/表头/按钮文字/输入值/标注元素定位，
// 结合页面功能即可写出标注与说明；视觉只用于核验框是否命中、布局是否错位。
const EXTRACT_CODE = `(() => {
  ${PAGE_JS_HELPERS}
  const clip = (s, n) => { s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; };
  const isVis = pbIsVisible;
  const desc = (el) => {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const d = { url: location.href, title: document.title, capturedAt: new Date().toISOString(),
    headings: [], buttons: [], inputs: [], tabs: [], menus: [], tables: [], cards: [], marks: [], notes: [] };

  // 标注目标（overlay 还在时从内部数据反查元素；overlay 已清时 specs 找不到框，marks 为空）
  const specs = PB_SPECS_PLACEHOLDER;
  if (Array.isArray(specs) && specs.length) {
    const resolve = pbResolve;
    specs.forEach((sp, i) => {
      const el = resolve(sp.selector);
      if (!el) { d.marks.push({ index: i + 1, label: sp.label, selector: sp.selector, found: false }); return; }
      const r = el.getBoundingClientRect();
      const vh = document.documentElement.clientHeight, vw = document.documentElement.clientWidth;
      d.marks.push({ index: i + 1, label: sp.label, selector: sp.selector, found: true,
        inView: r.top >= -2 && r.left >= -2 && r.bottom <= vh + 2 && r.right <= vw + 2,
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type') || '',
        text: clip(el.value !== undefined && el.value !== '' ? el.value : el.textContent, 120),
        placeholder: el.placeholder || '',
        className: clip(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className, 160),
        box: desc(el) });
    });
  }

  [...document.querySelectorAll('h1,h2,h3,h4,[class*=page-title],[class*=pageTitle],.el-page-header__title')]
    .filter(isVis).forEach((el) => { const t = clip(el.textContent, 80); if (t && !d.headings.includes(t)) d.headings.push(t); });

  [...document.querySelectorAll('.el-breadcrumb__item,.el-breadcrumb li,[class*=breadcrumb] [class*=item]')]
    .filter(isVis).slice(0, 12).forEach((el) => { const t = clip(el.textContent, 40); if (t && !d.tabs.includes(t)) d.tabs.push(t); });

  [...document.querySelectorAll('button,a.el-button,.el-button,[role=button],[role=tab],.el-tabs__item,.el-radio-button__inner')]
    .filter(isVis).slice(0, 60).forEach((el) => {
      const t = clip(el.textContent || el.getAttribute('aria-label'), 40);
      if (!t || d.buttons.some((b) => b.text === t)) return;
      d.buttons.push({ text: t, disabled: el.disabled || el.getAttribute('aria-disabled') === 'true' || el.className.includes('is-disabled'), box: desc(el) });
    });

  // 输入框：只收"真在给用户填"的——可见、尺寸足够、且有值或有占位提示
  // （跳过 el-table 表头筛选行那类无 label 无 placeholder 无值的空域、侧栏折叠搜索框、1px 隐藏域）
  [...document.querySelectorAll('input,textarea')].filter((el) => {
    if (!isVis(el) || el.type === 'hidden') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 18) return false;
    return !!(el.value || el.placeholder || el.name || el.getAttribute('aria-label'));
  }).slice(0, 40).forEach((el) => {
    d.inputs.push({ placeholder: clip(el.placeholder || el.getAttribute('aria-label'), 40), value: clip(el.value, 40),
      type: el.type || 'text', disabled: el.disabled || el.readOnly, name: clip(el.name, 30), box: desc(el) });
  });

  [...document.querySelectorAll('.el-menu-item.is-active,.el-tabs__item.is-active,[role=tab][aria-selected=true]')]
    .filter(isVis).slice(0, 10).forEach((el) => { const t = clip(el.textContent, 40); if (t && !d.menus.includes(t)) d.menus.push(t); });

  // 表格：el-table 的固定列表头/表体是克隆结构，按"列签名"去重，同列只留行数最多的那份
  const rawTables = [...document.querySelectorAll('table,.el-table')].filter(isVis).slice(0, 8);
  const tableGroups = new Map();
  for (const tbl of rawTables) {
    const headers = [...tbl.querySelectorAll('thead th .cell, thead th, .el-table__header th .cell, .el-table__header th')]
      .map((c) => clip(c.textContent, 20)).filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i);
    if (!headers.length) continue; // 固定列克隆常无完整表头，跳过
    const rows = [...tbl.querySelectorAll('tbody tr')].filter(isVis);
    const sig = headers.join("|");
    const prev = tableGroups.get(sig);
    if (!prev || rows.length > prev.rowCount) {
      const sample = [];
      for (const tr of rows.slice(0, 3)) {
        const seen = new Set();
        const cells = [...tr.querySelectorAll('td .cell, td')].map((c) => {
          const inp = c.querySelector('input,textarea');
          return clip(inp ? (inp.value || inp.placeholder) : c.textContent, 24);
        }).filter((v) => { if (seen.has(v)) return false; seen.add(v); return true; });
        sample.push(cells);
      }
      tableGroups.set(sig, { columns: headers.slice(0, 30), rowCount: rows.length, sampleRows: sample, box: desc(tbl) });
    }
  }
  let ti = 0;
  for (const t of tableGroups.values()) d.tables.push({ index: ++ti, ...t });

  // 业务卡片：叶子型卡片（month-card 等），避开卡片网格/内容容器
  const cardSel = '.month-card,.stat-card,[class*=card-item]';
  [...document.querySelectorAll(cardSel)].filter(isVis).slice(0, 24).forEach((el) => {
    const t = clip(el.textContent, 100);
    if (t && !d.cards.some((c) => c.text === t)) d.cards.push({ text: t, classes: clip(typeof el.className === 'string' ? el.className : '', 120), box: desc(el) });
  });

  [...document.querySelectorAll('.el-alert,[class*=empty],[class*=tip],[class*=notice]')].filter(isVis).slice(0, 10)
    .forEach((el) => { const t = clip(el.textContent, 160); if (t && !d.notes.some((n) => n.text === t)) d.notes.push({ text: t, box: desc(el) }); });

  ['headings', 'buttons', 'inputs', 'tabs', 'menus', 'cards', 'notes'].forEach((k) => { if (!d[k].length) delete d[k]; });
  if (!d.tables.length) delete d.tables;
  if (!d.marks.length) delete d.marks;
  return d;
})()`;

// 从当前页抽取结构化文档；specs 为标注规范时连标注元素的真实文字/值/坐标一起抽出
async function extractPageDoc(meta, specs = null) {
  const code = EXTRACT_CODE.replace("PB_SPECS_PLACEHOLDER", JSON.stringify(specs || null));
  const res = await wb.evalJs(code, meta.session);
  return res?.value ?? res;
}

// regAttachDoc 由 registry.mjs 提供（sidecar 写盘通过 writeFileSync 注入，保持 fs 单一入口）

// 标注 + 截图 + 文档识别 + 清理，返回 {path, marks, doc}
async function takeAnnotatedShot(dir, meta, stepNo, suffix, specs, { withDoc = true } = {}) {
  const marks = await injectMarks(meta, specs);
  await new Promise((r) => setTimeout(r, 180));
  let path = null;
  let doc = null;
  try {
    path = await takeShot(dir, meta, stepNo, suffix);
    // 标注层还在，正好抽取每个标注元素的真实文字/值/坐标 —— 文档识别，不消耗视觉
    if (withDoc) {
      try {
        doc = await extractPageDoc(meta, specs);
        regAttachDoc(dir, path, doc, (p, content) => writeFileSync(p, content), "dom+mark");
      } catch (err) {
        process.stderr.write(`playbook: 文档识别失败（不影响截图）: ${err.message}\n`);
      }
    }
  } finally {
    await clearMarks(meta);
  }
  const missing = (marks || []).filter((m) => !m.found);
  const offscreen = (marks || []).filter((m) => m.found && !m.inView);
  if (missing.length || offscreen.length) {
    process.stderr.write(
      `playbook: 标注提示 — 未命中：${missing.map((m) => m.selector).join("、") || "无"}；不在视口：${offscreen.map((m) => m.selector).join("、") || "无"}\n`,
    );
  }
  return { path, marks: marks || [], doc };
}

// ---------- 安全闸门 / 等待 / 快照瘦身 ----------
// 危险动作：在测试/生产系统可能改数据。工具层兜底——必须显式 --allow-danger 或 PLAYBOOK_ALLOW_DANGER=1。
const DANGER_PATTERNS = [
  { re: /text=\s*(保存|提交|确定|确认(复制|保存|提交|删除|操作)?|删除|移除|清空|重置|覆盖|启用|停用|审核|审批|发布|作废)/ },
  { re: /[.#][\w-]*(danger|error|delete|remove)/i },
  { re: /\b(delete|remove|submit|save|confirm)\b/i },
];
function looksDangerous(selector, title) {
  const hay = `${selector || ""}\n${title || ""}`;
  return DANGER_PATTERNS.some((p) => p.re.test(hay));
}
function guardDanger(selector, flags, title) {
  if (flags["allow-danger"] || process.env.PLAYBOOK_ALLOW_DANGER === "1") return;
  if (looksDangerous(selector, title)) {
    fail(
      `检测到危险动作「${title || selector}」（可能保存/提交/删除真实数据）。\n` +
      "如已与用户确认只录不存或确在演练环境，加 --allow-danger（或设 PLAYBOOK_ALLOW_DANGER=1）再执行。",
    );
  }
}
function waitMs(flags, fallback = 700) {
  const w = Number(flags.wait);
  return Number.isFinite(w) && w >= 0 ? Math.min(60_000, w) : fallback;
}
async function snapMaybe(meta, flags) {
  if (flags["no-tree"]) return null;
  return wb.snapshot(meta.session);
}

// ---------- 子命令 ----------
async function cmdStart([url], flags) {
  if (!url) fail("start <url> --title <标题>");
  const slug = slugify(flags.slug || flags.title || url);
  const root = flags.dir ? resolve(flags.dir) : join(process.cwd(), "playbook-runs", slug);
  if (existsSync(join(root, "meta.json"))) fail(`run 已存在：${root}（如需继续录制直接在该目录下执行子命令）`);
  mkdirSync(join(root, "assets"), { recursive: true });
  const meta = {
    slug,
    title: flags.title || url,
    url,
    session: `playbook-${slug}`,
    createdAt: new Date().toISOString(),
    schemaVersion: 2,
  };
  saveMeta(root, meta);
  writeFileSync(join(root, "steps.jsonl"), "");

  const nav = await wb.navigate(url, { newTab: true, groupTitle: meta.title, session: meta.session });
  await new Promise((r) => setTimeout(r, 1200));
  const shot = await takeShot(root, meta, 0, "-page");
  regTouch(root, shot);
  meta.pageShot = shot;
  saveMeta(root, meta);
  const snap = await wb.snapshot(meta.session);
  out({
    runDir: root,
    session: meta.session,
    nav,
    pageShot: toPortable(shot, root),
    url: snap.url,
    title: snap.title,
    tree: snap.tree,
    hint: "先用 section 声明模块/流程，再录操作；阅读 tree，在聊天中给出候选操作流，确认后开录",
  });
}

async function withRun(flags, fn) {
  const dir = findRunDir(flags.dir);
  if (!dir) fail("找不到 run 目录（需要 meta.json + steps.jsonl）。先 start，或用 --dir 指定。");
  const run = loadRun(dir);
  await fn(dir, run.meta, run.steps);
}

async function cmdGoto(args, flags) {
  const url = args[0];
  if (!url) fail("goto <url>");
  await withRun(flags, async (dir, meta, steps) => {
    const nav = await wb.navigate(url, { newTab: false, session: meta.session });
    await new Promise((r) => setTimeout(r, waitMs(flags, 1000)));
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const markSpecs = parseMarks(flags.mark ? [flags.mark] : []);
    let after = null;
    let marks = [];
    if (markSpecs.length) ({ path: after, marks } = await takeAnnotatedShot(dir, meta, n, "-after", markSpecs));
    else if (!flags["no-shot"]) after = await takeShot(dir, meta, n, "-after");
    const snap = await snapMaybe(meta, flags);
    steps.push({
      id: n,
      kind: "goto",
      title: flags.title || `打开 ${url}`,
      note: flags.note || "",
      url,
      ...(marks.length ? { marks } : {}),
      shots: { ...(after ? { after } : {}) },
      ts: new Date().toISOString(),
    });
    saveSteps(dir, steps);
    const payload = { step: n, nav, shot: after, marks };
    if (snap) { payload.url = snap.url; payload.title = snap.title; payload.tree = snap.tree; } else payload.treeSuppressed = true;
    out(payload);
  });
}

async function cmdSnap(args, flags) {
  await withRun(flags, async (dir, meta) => {
    const snap = await wb.snapshot(meta.session);
    if (flags.save) writeFileSync(join(dir, "last-snapshot.json"), JSON.stringify(snap, null, 2));
    out(snap);
  });
}

async function cmdAction(kind, args, flags) {
  const selector = args[0];
  const value = args[1];
  if (!selector) fail(`${kind} <selector> [value] --title ... --note ...`);
  if (!flags.title) fail(`--title 必填（这一步在文档里的步骤标题）`);
  if (kind === "click") guardDanger(selector, flags, flags.title);
  await withRun(flags, async (dir, meta, steps) => {
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    let before = null;
    if (flags.before) before = await takeShot(dir, meta, n, "-before");

    let result;
    if (kind === "click") result = await wb.click(selector, meta.session);
    else if (kind === "fill") {
      if (!value) fail("fill <selector> <value>");
      result = await wb.fill(selector, value, meta.session);
    } else if (kind === "scroll") {
      const dir2 = selector; // scroll 的第一个位置参数是方向
      result = await wb.scroll(dir2, value || 500, meta.session);
    }
    await new Promise((r) => setTimeout(r, waitMs(flags)));

    const markSpecs = parseMarks(flags.mark ? [flags.mark] : []);
    let after = null;
    let marks = [];
    if (markSpecs.length) ({ path: after, marks } = await takeAnnotatedShot(dir, meta, n, "-after", markSpecs));
    else if (!flags["no-shot"]) after = await takeShot(dir, meta, n, "-after");
    const snap = await snapMaybe(meta, flags);
    steps.push({
      id: n,
      kind,
      title: String(flags.title),
      note: flags.note ? String(flags.note) : "",
      selector: kind === "scroll" ? undefined : selector,
      value: kind === "fill" ? value : kind === "scroll" ? String(value || 500) : undefined,
      direction: kind === "scroll" ? selector : undefined,
      result,
      ...(marks.length ? { marks } : {}),
      shots: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
      ts: new Date().toISOString(),
    });
    saveSteps(dir, steps);
    const payload = { step: n, kind, result, shots: steps.at(-1).shots, marks };
    if (snap) { payload.url = snap.url; payload.tree = snap.tree; } else payload.treeSuppressed = true;
    out(payload);
  });
}

async function cmdEval(args, flags) {
  const code = flags.code || args[0];
  if (!code) fail("eval --code '...'  或 eval '<js 表达式>'（快照无 @e 引用时的退路）");
  if (!flags.title) fail("--title 必填");
  // eval 可执行任意页面 JS：出现写操作关键字时走同一道闸门
  if (/\.(post|put|delete)\s*\(|fetch\s*\(\s*['"][^'"]+['"]\s*,\s*\{?\s*method\s*:\s*['"](POST|PUT|DELETE)/i.test(code)) {
    guardDanger(`text=提交`, flags, flags.title);
  }
  await withRun(flags, async (dir, meta, steps) => {
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const before = flags.before ? await takeShot(dir, meta, n, "-before") : null;
    const result = await wb.evalJs(code, meta.session);
    await new Promise((r) => setTimeout(r, waitMs(flags, 800)));
    const markSpecs = parseMarks(flags.mark ? [flags.mark] : []);
    let after = null;
    let marks = [];
    if (markSpecs.length) ({ path: after, marks } = await takeAnnotatedShot(dir, meta, n, "-after", markSpecs));
    else if (!flags["no-shot"]) after = await takeShot(dir, meta, n, "-after");
    const snap = await snapMaybe(meta, flags);
    steps.push({
      id: n,
      kind: "eval",
      title: String(flags.title),
      note: flags.note ? String(flags.note) : "",
      code,
      result: result?.value ?? result,
      ...(marks.length ? { marks } : {}),
      shots: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
      ts: new Date().toISOString(),
    });
    saveSteps(dir, steps);
    const payload = { step: n, kind: "eval", result: result?.value ?? result, shots: steps.at(-1).shots, marks };
    if (snap) { payload.url = snap.url; payload.tree = snap.tree; } else payload.treeSuppressed = true;
    out(payload);
  });
}

async function cmdNote(args, flags) {
  if (!flags.title) fail("note --title ... [--note ...]");
  await withRun(flags, async (dir, _meta, steps) => {
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const entry = { id: n, kind: "note", title: String(flags.title), note: flags.note ? String(flags.note) : "", ts: new Date().toISOString() };
    if (flags.after) {
      const idx = steps.findIndex((x) => x.id === Number(flags.after) && !x.dropped);
      if (idx < 0) fail(`没有第 ${flags.after} 步`);
      steps.splice(idx + 1, 0, entry);
    } else steps.push(entry);
    saveSteps(dir, steps);
    out({ step: n, kind: "note" });
  });
}

async function cmdShot(args, flags) {
  await withRun(flags, async (dir, meta, steps) => {
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const path = await takeShot(dir, meta, n, "-after");
    const entry = {
      id: n, kind: "shot",
      title: flags.title ? String(flags.title) : "页面状态",
      note: flags.note ? String(flags.note) : "",
      shots: { after: path }, ts: new Date().toISOString(),
    };
    insertOrPush(steps, entry, flags.after);
    saveSteps(dir, steps);
    out({ step: n, kind: "shot", shot: path });
  });
}

// 独立标注截图：mark "选择器|标签" ["选择器2|标签2" ...] --title ...
async function cmdMark(args, flags) {
  if (!args.length) fail('mark "<css|标签>" ["text=文字|标签" ...] --title "图题" [--note ...] [--after N] [--step N]');
  if (!flags.title) fail("--title 必填");
  const specs = parseMarks(args);
  await withRun(flags, async (dir, meta, steps) => {
    // --step N：重新标注并替换某已有步骤的主图
    if (flags.step) {
      const target = steps.find((x) => x.id === Number(flags.step) && !x.dropped);
      if (!target) fail(`没有第 ${flags.step} 步`);
      const { path, marks } = await takeAnnotatedShot(dir, meta, target.id, "-mark", specs);
      target.shots = target.shots || {};
      target.shots.after = path;
      target.marks = marks;
      if (flags.note !== undefined) target.note = String(flags.note === true ? target.note || "" : flags.note);
      target.remarkedAt = new Date().toISOString();
      saveSteps(dir, steps);
      out({ step: target.id, shot: path, marks });
      return;
    }
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const { path, marks } = await takeAnnotatedShot(dir, meta, n, "-after", specs);
    const entry = {
      id: n,
      kind: "shot",
      title: String(flags.title),
      note: flags.note ? String(flags.note === true ? "" : flags.note) : "",
      marks,
      shots: { after: path },
      ts: new Date().toISOString(),
    };
    insertOrPush(steps, entry, flags.after);
    saveSteps(dir, steps);
    out({ step: n, kind: "mark-shot", shot: path, marks });
  });
}

async function cmdUnmark(args, flags) {
  await withRun(flags, async (_dir, meta) => {
    await clearMarks(meta);
    out({ cleared: true });
  });
}

// 声明层级节点：section --level 1|2|3 --title 模块名 [--summary 一句话] [--note 详述] [--after N]
async function cmdSection(args, flags) {
  if (!flags.title) fail("section --level 1|2|3 --title 名称 [--summary 概述] [--note 说明] [--after N]");
  const level = Number(flags.level || args[0]);
  if (![1, 2, 3].includes(level)) fail("--level 必须是 1=模块 / 2=流程 / 3=页面或阶段");
  await withRun(flags, async (dir, _meta, steps) => {
    const n = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const entry = {
      id: n,
      kind: "section",
      level,
      title: String(flags.title),
      summary: flags.summary ? String(flags.summary) : "",
      note: flags.note ? String(flags.note === true ? "" : flags.note) : "",
      ts: new Date().toISOString(),
    };
    insertOrPush(steps, entry, flags.after);
    saveSteps(dir, steps);
    const tree = numberTree(buildTree(steps));
    let code = "";
    for (const m of tree.modules) {
      if (m.id === n) code = m.code;
      for (const f of m.flows) {
        if (f.id === n) code = f.code;
        for (const p of f.pages) if (p.id === n) code = p.code;
      }
    }
    out({ section: n, level, title: entry.title, code, hint: "其后录制的步骤自动归入该节点，直到出现同级或更高级 section" });
  });
}

// 移动步骤：mv <id> --after N | --section <sectionId>
async function cmdMv(args, flags) {
  const id = Number(args[0]);
  if (!id) fail("mv <步骤id> --after <目标步骤id> | --section <section id>");
  await withRun(flags, async (dir, _meta, steps) => {
    const fromIdx = steps.findIndex((x) => x.id === id && !x.dropped);
    if (fromIdx < 0) fail(`没有第 ${id} 步`);
    const [entry] = steps.splice(fromIdx, 1);
    let toIdx;
    if (flags.section) {
      toIdx = steps.findIndex((x) => x.id === Number(flags.section) && x.kind === "section" && !x.dropped);
      if (toIdx < 0) fail(`没有 section #${flags.section}`);
    } else {
      const afterId = Number(flags.after);
      if (!afterId) fail("需要 --after N 或 --section N");
      toIdx = steps.findIndex((x) => x.id === afterId && !x.dropped);
      if (toIdx < 0) fail(`没有第 ${afterId} 步`);
    }
    steps.splice(toIdx + 1, 0, entry);
    saveSteps(dir, steps);
    const tree = numberTree(buildTree(steps));
    out({ moved: id, order: steps.filter((s) => !s.dropped).map((s) => s.id), outline: outlineText(tree) });
  });
}

async function cmdOutline(args, flags) {
  await withRun(flags, async (dir, _meta, steps) => {
    const tree = numberTree(buildTree(steps));
    process.stdout.write(outlineText(tree, { withIds: true }) + "\n");
    if (tree.diagnostics.length && !flags.quiet) {
      process.stderr.write(`\n诊断：\n${tree.diagnostics.map((d) => `- [${d.level}] ${d.msg}`).join("\n")}\n`);
    }
  });
}

// 登记一张图的识图结论（AI 看一次图后立刻 see，之后改文案/重排不再重复看图）
// see <步骤id|assets文件名> --desc "一句话结论" [--ocr "关键文字/元素"] [--el "按钮/输入框定位"]
async function cmdSee(args, flags) {
  if (!args[0] || !flags.desc) fail('see <步骤id|文件名> --desc "识图结论" [--ocr "…"] [--el "…"]');
  await withRun(flags, async (dir, meta, steps) => {
    let file = null;
    const key = args[0];
    const asId = Number(key);
    if (asId && steps.some((s) => s.id === asId)) {
      const s = steps.find((x) => x.id === asId);
      file = s.shots?.after || s.file || null;
      if (!file) fail(`步骤 #${asId} 没有可登记的图片`);
    } else {
      const cand = join(dir, "assets", basename(String(key)));
      if (!existsSync(cand)) fail(`找不到图片：${key}（可传步骤 id 或 assets 下文件名）`);
      file = cand;
    }
    regTouch(dir, file); // 先按当前内容建条目（内容变过则旧缓存已失效）
    const reg = loadRegistry(dir);
    const name = basename(file);
    reg.files[name].vision = {
      desc: String(flags.desc),
      ocr: flags.ocr ? String(flags.ocr) : "",
      elements: flags.el ? String(flags.el) : "",
      seenAt: new Date().toISOString(),
    };
    saveRegistry(dir, reg);
    out({ asset: name, step: asId || undefined, vision: reg.files[name].vision });
  });
}

// 文档识别（DOM 优先）：doc [--step N] [--asset 文件名]
// 对当前页抽取结构化文档并登记到某张截图：标注图连元素真实文字/值/坐标一起抽取，零视觉 token。
// 用途：①历史标注图在对应页面补登；②普通页截图快速登记页面功能信息；③视觉只在 DOM 拿不到时兜底。
async function cmdDoc(args, flags) {
  await withRun(flags, async (dir, meta, steps) => {
    let imgPath = null;
    let specs = null;
    if (flags.step) {
      const target = steps.find((x) => x.id === Number(flags.step) && !x.dropped);
      if (!target) fail(`没有第 ${flags.step} 步`);
      imgPath = target.shots?.after || null;
      if (!imgPath) fail(`步骤 #${flags.step} 没有截图`);
      specs = Array.isArray(target.marks)
        ? target.marks.map((m, i) => ({ selector: m.selector, label: m.label, color: MARK_COLORS[i % MARK_COLORS.length] }))
        : null;
    } else if (flags.asset) {
      imgPath = join(dir, "assets", basename(String(flags.asset)));
      if (!existsSync(imgPath)) fail(`找不到图片：${flags.asset}`);
    } else {
      fail("doc --step N  或  doc --asset 文件名（先让浏览器停在截图时的同一页面状态）");
    }
    const doc = await extractPageDoc(meta, specs);
    const { compact } = regAttachDoc(dir, imgPath, doc, (p, content) => writeFileSync(p, content), specs?.length ? "dom+mark" : "dom");
    out({ attachedTo: basename(imgPath), recognized: true, page: compact.pageTitle, summary: compact });
  });
}

// 资产清单：哪些图已识别（DOM 文档 / 视觉）、哪些还没看；--backfill 为历史图片补算哈希
async function cmdAssets(args, flags) {
  await withRun(flags, async (dir) => {
    if (flags.backfill) {
      for (const f of readdirSync(join(dir, "assets"))) {
        if (f.startsWith(".") || !/\.(png|jpe?g|gif|webp)$/i.test(f)) continue;
        regTouch(dir, join(dir, "assets", f));
      }
    }
    const reg = loadRegistry(dir);
    const rows = Object.entries(reg.files)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, e]) => ({
        asset: name,
        kb: Math.round(e.bytes / 1024),
        source: e.doc ? e.doc.source || "dom" : e.vision ? "vision" : "",
        seen: !!(e.vision || e.doc),
        desc: e.vision?.desc || (e.doc ? `[DOM] ${(e.doc.headings || []).concat(e.doc.menus || []).join(" / ") || e.doc.pageTitle}` : ""),
        sha: e.sha256.slice(0, 10),
      }));
    out({
      total: rows.length,
      seen: rows.filter((r) => r.seen).length,
      byDom: rows.filter((r) => r.source.startsWith("dom")).length,
      byVision: rows.filter((r) => r.source === "vision").length,
      unseen: rows.filter((r) => !r.seen).map((r) => r.asset),
      files: rows,
    });
  });
}

async function cmdCheck(args, flags) {
  await withRun(flags, async (dir, _meta, steps) => {
    const tree = numberTree(buildTree(steps));
    const missingMarkShots = steps
      .filter((s) => !s.dropped && Array.isArray(s.marks) && s.marks.some((m) => m.found === false))
      .map((s) => ({ id: s.id, title: s.title, missing: s.marks.filter((m) => !m.found).map((m) => m.selector) }));
    const actionKinds = ["goto", "click", "fill", "scroll", "eval", "shot"];
    const noAfter = steps
      .filter((s) => !s.dropped && !s.appendix && actionKinds.includes(s.kind) && !s.shots?.after)
      .map((s) => ({ id: s.id, title: s.title }));
    // 交付用截图若一张都没识别过（DOM 文档或视觉）——包括 registry 里根本没条目的情况——提示补 doc/see
    const reg = loadRegistry(dir);
    const unrecognizedShots = steps
      .filter((s) => !s.dropped && actionKinds.includes(s.kind) && s.shots?.after)
      .filter((s) => {
        const e = reg.files[basename(s.shots.after)];
        return !e || (!e.doc && !e.vision);
      })
      .map((s) => ({ id: s.id, title: s.title, asset: basename(s.shots.after) }));
    // 引用了但磁盘缺失的图（run 搬家/误删时立刻暴露）
    const missingFiles = steps
      .filter((s) => !s.dropped && s.shots?.after && !existsSync(s.shots.after))
      .map((s) => ({ id: s.id, title: s.title, asset: basename(s.shots.after) }));
    out({ diagnostics: tree.diagnostics, missingMarkShots, stepsWithoutAfterShot: noAfter, unrecognizedShots, missingFiles });
  });
}

function insertOrPush(steps, entry, afterId) {
  if (afterId) {
    const idx = steps.findIndex((x) => x.id === Number(afterId) && !x.dropped);
    if (idx < 0) fail(`没有第 ${afterId} 步`);
    steps.splice(idx + 1, 0, entry);
  } else steps.push(entry);
}

async function cmdAmend(args, flags) {
  const id = Number(args[0]);
  if (!id) fail("amend <步骤号> [--title ..] [--note ..] [--summary ..]");
  await withRun(flags, async (dir, _meta, steps) => {
    const s = steps.find((x) => x.id === id && !x.dropped);
    if (!s) fail(`没有第 ${id} 步`);
    if (flags.title) s.title = String(flags.title);
    if (flags.note !== undefined) s.note = String(flags.note === true ? "" : flags.note);
    if (flags.summary !== undefined && s.kind === "section") s.summary = String(flags.summary === true ? "" : flags.summary);
    s.amendedAt = new Date().toISOString();
    saveSteps(dir, steps);
    out({ step: id, title: s.title, note: s.note, ...(s.kind === "section" ? { level: s.level, summary: s.summary } : {}) });
  });
}

async function cmdInsert(args, flags) {
  const afterId = Number(args[0]);
  const kind = args[1] || "note";
  if (!afterId || !flags.title) fail("insert <在第N步之后> note|shot --title ... [--note ...]");
  await withRun(flags, async (dir, meta, steps) => {
    const idx = steps.findIndex((x) => x.id === afterId && !x.dropped);
    if (idx < 0) fail(`没有第 ${afterId} 步`);
    const nextId = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const entry = { id: nextId, kind, title: String(flags.title), note: flags.note ? String(flags.note) : "", ts: new Date().toISOString() };
    if (kind === "shot") {
      const path = await takeShot(dir, meta, nextId, "-after");
      entry.shots = { after: path };
    }
    steps.splice(idx + 1, 0, entry);
    saveSteps(dir, steps);
    out({ inserted: nextId, after: afterId, order: steps.filter((s) => !s.dropped).map((s) => s.id) });
  });
}

async function cmdDrop(args, flags) {
  const id = Number(args[0]);
  if (!id) fail("drop <步骤号>");
  await withRun(flags, async (dir, _meta, steps) => {
    const s = steps.find((x) => x.id === id);
    if (!s) fail(`没有第 ${id} 步`);
    s.dropped = true;
    saveSteps(dir, steps);
    out({ dropped: id, remaining: steps.filter((x) => !x.dropped).map((x) => x.id) });
  });
}

async function cmdReshoot(args, flags) {
  const id = Number(args[0]);
  if (!id) fail("reshoot <步骤号> [--title ..]");
  await withRun(flags, async (dir, meta, steps) => {
    const s = steps.find((x) => x.id === id && !x.dropped);
    if (!s) fail(`没有第 ${id} 步`);
    const path = await takeShot(dir, meta, id, "-reshoot");
    s.shots = s.shots || {};
    s.shots.after = path; // 重拍图替换主图；旧图保留在 assets
    if (flags.title) s.title = String(flags.title);
    if (flags.note !== undefined) s.note = String(flags.note === true ? "" : flags.note);
    s.reshotAt = new Date().toISOString();
    saveSteps(dir, steps);
    out({ step: id, shot: path });
  });
}

async function cmdAttach(args, flags) {
  const filePath = args[0];
  if (!filePath || !flags.title) fail("attach <文件路径> --title ... [--note ...] [--after N]");
  await withRun(flags, async (dir, _meta, steps) => {
    const src = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
    if (!existsSync(src)) fail(`文件不存在：${src}`);
    const nextId = Math.max(0, ...steps.map((s) => s.id)) + 1;
    const ext = src.split(".").pop()?.toLowerCase().match(/^[a-z0-9]+$/)?.[0] || "bin";
    const destName = `attach-${String(nextId).padStart(3, "0")}-${basename(src)}`;
    const dest = join(dir, "assets", destName);
    copyFileSync(src, dest);
    if (/^(png|jpe?g|gif|webp)$/i.test(ext)) regTouch(dir, dest);
    const entry = {
      id: nextId,
      kind: "attach",
      title: String(flags.title),
      note: flags.note ? String(flags.note) : "",
      file: dest,
      ext,
      ts: new Date().toISOString(),
    };
    if (flags.after) {
      const idx = steps.findIndex((x) => x.id === Number(flags.after) && !x.dropped);
      if (idx < 0) fail(`没有第 ${flags.after} 步`);
      steps.splice(idx + 1, 0, entry);
    } else {
      entry.appendix = true;
      steps.push(entry);
    }
    saveSteps(dir, steps);
    out({ attached: nextId, as: dest, appendix: !!entry.appendix });
  });
}

// 旧 run 一次性迁移：steps/meta 里的绝对资产路径相对化，使 run 目录可整体搬迁
async function cmdMigrate(args, flags) {
  await withRun(flags, async (dir, meta, steps) => {
    // loadRun 已把旧绝对路径还原为当前机器上可用的绝对路径（搬家后按 assets 尾段回指）
    const stepCount = portableMigrate(meta, steps, dir);
    const hadMetaAbs = String(meta.pageShot || "").startsWith("/");
    saveSteps(dir, steps);
    saveMeta(dir, meta);
    out({ migrated: true, convertedAssetPaths: stepCount + (hadMetaAbs ? 1 : 0), runDir: dir });
  });
}

// ---------- 入口 ----------
const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseFlags(rest);

const handlers = {
  start: () => cmdStart(positional, flags),
  goto: () => cmdGoto(positional, flags),
  snap: () => cmdSnap(positional, flags),
  click: () => cmdAction("click", positional, flags),
  fill: () => cmdAction("fill", positional, flags),
  scroll: () => cmdAction("scroll", positional, flags),
  note: () => cmdNote(positional, flags),
  eval: () => cmdEval(positional, flags),
  shot: () => cmdShot(positional, flags),
  mark: () => cmdMark(positional, flags),
  unmark: () => cmdUnmark(positional, flags),
  section: () => cmdSection(positional, flags),
  mv: () => cmdMv(positional, flags),
  outline: () => cmdOutline(positional, flags),
  check: () => cmdCheck(positional, flags),
  see: () => cmdSee(positional, flags),
  doc: () => cmdDoc(positional, flags),
  assets: () => cmdAssets(positional, flags),
  amend: () => cmdAmend(positional, flags),
  insert: () => cmdInsert(positional, flags),
  drop: () => cmdDrop(positional, flags),
  reshoot: () => cmdReshoot(positional, flags),
  attach: () => cmdAttach(positional, flags),
  migrate: () => cmdMigrate(positional, flags),
};

if (!handlers[command]) {
  fail(
    `未知命令：${command || "(空)"}\n可用：start | goto | snap | click | fill | scroll | note | eval | shot |\n` +
      "      mark | unmark | section | mv | outline | check | see | doc | assets |\n" +
      "      amend | insert | drop | reshoot | attach | migrate",
  );
}
handlers[command]().catch((e) => fail(e.stack || e.message));
