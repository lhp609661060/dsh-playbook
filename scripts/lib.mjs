// dsh-playbook 共享工具 + 数据模型。
import { isAbsolute, relative, resolve } from "node:path";

// ---------- 极简参数解析（record/assemble/export/preview 共用，行为一致） ----------
// 支持：--flag value｜--flag=value｜--bool｜-o value（单短横）｜-o=value｜重复同名 flag 用 ;; 聚合
export function parseArgs(argv, { repeatKeys = ["mark"] } = {}) {
  const positional = [];
  const flags = {};
  const setFlag = (key, val) => {
    if (repeatKeys.includes(key)) {
      if (flags[key] === undefined) flags[key] = val;
      else flags[key] += `;;${val}`;
    } else flags[key] = val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) { setFlag(body.slice(0, eq), body.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) { flags[body] = true; }
      else { setFlag(body, next); i++; }
    } else if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
      const body = a.slice(1);
      const eq = body.indexOf("=");
      if (eq >= 0) { setFlag(body.slice(0, eq), body.slice(eq + 1)); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) { flags[body] = true; }
      else { setFlag(body, next); i++; }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

// ---------- steps.jsonl 读取（单行损坏给出行号，不抛裸堆栈） ----------
export function parseJsonl(text) {
  const steps = [];
  const badLines = [];
  text.split("\n").forEach((line, idx) => {
    if (!line.trim()) return;
    try {
      steps.push(JSON.parse(line));
    } catch {
      badLines.push(idx + 1);
    }
  });
  return { steps, badLines };
}

// ---------- run 可移植性：steps/meta 内只存相对 run 目录的资产路径 ----------
const ASSET_RE = /^assets\//;
export function toPortable(p, runDir) {
  if (!p || typeof p !== "string") return p;
  if (ASSET_RE.test(p)) return p;
  if (isAbsolute(p)) {
    const rel = relative(runDir, p);
    if (rel && !rel.startsWith("..")) return rel;
  }
  return p;
}
export function toAbs(p, runDir) {
  if (!p || typeof p !== "string") return p;
  if (isAbsolute(p)) return existsOrLegacy(p, runDir);
  return resolve(runDir, p);
}
function existsOrLegacy(abs, runDir) {
  // 旧 run 可能整体搬家：绝对路径已不存在时，按其 assets/<name> 尾段回到当前 run 目录
  try {
    // 延迟依赖 fs，避免 lib 单测时强耦合
    const { existsSync } = requireFs();
    if (existsSync(abs)) return abs;
  } catch { /* ignore */ }
  const i = abs.indexOf("assets/");
  if (i >= 0) return resolve(runDir, abs.slice(i));
  return abs;
}
import { existsSync as _existsSync } from "node:fs";
function requireFs() { return { existsSync: _existsSync }; }

// 把一个 run 的内存 steps/meta 绝对资产路径相对化；返回迁移到的路径数
export function portableMigrate(meta, steps, runDir) {
  let count = 0;
  const conv = (p) => {
    const np = toPortable(p, runDir);
    if (np !== p) { count++; return np; }
    return p;
  };
  if (meta.pageShot) meta.pageShot = conv(meta.pageShot);
  for (const s of steps) {
    if (s.shots) {
      if (s.shots.before) s.shots.before = conv(s.shots.before);
      if (s.shots.after) s.shots.after = conv(s.shots.after);
    }
    if (s.file) s.file = conv(s.file);
  }
  return count;
}

// ---------- 页内注入 JS：标注器与文档识别共用的解析/可见性逻辑（只维护这一份） ----------
export const PAGE_JS_HELPERS = `
const pbIsVisible = (el) => {
  if (!el || el.closest('#__pb_marks')) return false;
  const r = el.getBoundingClientRect();
  const st = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
};
// 选择器 → 元素。支持：CSS、@attr=value（临时 data-pb 锚点）、text=文字
const pbResolve = (sel) => {
  if (sel.startsWith('@')) {
    const eq = sel.indexOf('=');
    const attr = sel.slice(1, eq); const val = sel.slice(eq + 1);
    return [...document.querySelectorAll('[' + attr + ']')]
      .filter(pbIsVisible).find((e) => e.getAttribute(attr) === val) || null;
  }
  if (sel.startsWith('text=')) {
    const want = sel.slice(5).trim();
    // ① 优先可交互元素（按钮文字常与图标同处一个非叶子 span，只查叶子会撞到说明段落）
    const interSel = 'button,a,[role=button],[role=tab],[role=menuitem],.el-button,.el-menu-item,.el-sub-menu__title,.el-tabs__item,input[placeholder]';
    const inter = [...document.querySelectorAll(interSel)].filter(pbIsVisible)
      .map((e) => ({ e, t: (e.textContent || e.placeholder || '').trim() }))
      .filter((x) => x.t === want || x.t.includes(want));
    if (inter.length) {
      const exact = inter.filter((x) => x.t === want);
      return (exact.length ? exact : inter).map((x) => x.e)
        .sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height
          - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    }
    // ② XPath：自身文本节点直接包含目标
    const xp = '//*[not(self::script) and contains(normalize-space(text()), "' + want.replace(/"/g, '\\\\"') + '")]';
    const hit = document.evaluate(xp, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    for (let i = 0; i < hit.snapshotLength; i++) {
      const el = hit.snapshotItem(i);
      if (pbIsVisible(el)) return el;
    }
    // ③ 退化：叶子文本元素（表头 .cell / label），先精确后包含、取最小
    const leafs = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const e = walker.currentNode;
      if (e.children.length === 0) {
        const t = (e.textContent || e.placeholder || '').trim();
        if (t && t.includes(want) && pbIsVisible(e)) leafs.push(e);
      }
    }
    if (leafs.length) {
      const exact = leafs.filter((e) => (e.textContent || '').trim() === want);
      const pool = exact.length ? exact : leafs;
      return pool.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height
        - b.getBoundingClientRect().width * b.getBoundingClientRect().height)[0];
    }
    return null;
  }
  try {
    const list = [...document.querySelectorAll(sel)].filter(pbIsVisible);
    if (!list.length) return null;
    // 多命中时取面积最小的（最贴近目标元素）
    return list.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    })[0];
  } catch { return null; }
};
`;

//
// 步骤类型：
//   section: { id, kind:"section", level:1|2|3, title, summary?, note? }
//     level 1 = 模块（如 登录）、2 = 业务流程（如 登录并进入系统）、
//     3 = 页面/阶段（如 输入账号密码页）
//   叶子：goto/click/fill/scroll/eval/shot/note/attach（带 dropped 标记的跳过）
//
// 归属规则（section 栈）：叶子归属于它之前最近的 section；遇更深 level 入栈；
// 遇 <= 栈顶 level 出栈到对应深度。直接挂在模块下的叶子用隐式页面「(概述)」承载；
// 模块之前的叶子归入隐式模块「(未分组)」，保证旧平铺数据 100% 兼容。

export function loadRun(dir, fs) {
  const meta = JSON.parse(fs.readFileSync(fs.join(dir, "meta.json"), "utf8"));
  const steps = fs
    .readFileSync(fs.join(dir, "steps.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { dir, meta, steps };
}

export function activeSteps(steps) {
  return steps.filter((s) => !s.dropped);
}

// 构造树。返回 { root, modules, implicitUngrouped, diagnostics }
export function buildTree(steps, { createImplicits = true } = {}) {
  const seq = activeSteps(steps);
  const diagnostics = [];
  const root = { type: "root", level: 0, title: "", children: [] };
  const stack = [root];
  const at = (lvl) => stack[lvl] || null;
  let implicitUngrouped = false;

  const ensureUngrouped = () => {
    if (implicitUngrouped) return stack[1];
    const m = { type: "module", level: 1, title: "(未分组)", implicit: true, children: [], flows: [], leaves: [] };
    root.children.push(m);
    stack[1] = m;
    stack.length = 2;
    implicitUngrouped = true;
    return m;
  };

  for (const s of seq) {
    if (s.kind === "section") {
      const lvl = Number(s.level) || 3;
      if (lvl === 1) {
        // 模块：重置栈
        stack.length = 1;
        const m = { type: "module", level: 1, id: s.id, title: s.title, summary: s.summary || "", note: s.note || "", children: [], flows: [], leaves: [] };
        root.children.push(m);
        stack[1] = m;
        stack.length = 2;
      } else if (lvl === 2) {
        if (!at(1)) {
          diagnostics.push({ level: "warn", stepId: s.id, msg: `流程「${s.title}」前没有模块，已放入「(未分组)」` });
          ensureUngrouped();
        }
        stack.length = 2;
        const f = { type: "flow", level: 2, id: s.id, title: s.title, summary: s.summary || "", note: s.note || "", children: [], pages: [], leaves: [] };
        stack[1].children.push(f);
        stack[1].flows.push(f);
        stack[2] = f;
        stack.length = 3;
      } else {
        if (!at(1)) {
          diagnostics.push({ level: "warn", stepId: s.id, msg: `页面/阶段「${s.title}」前没有模块，已放入「(未分组)」` });
          ensureUngrouped();
        }
        if (!at(2)) {
          // 页面直接挂模块：建隐式流程「(主流程)」
          const f = { type: "flow", level: 2, title: "(主流程)", implicit: true, children: [], pages: [], leaves: [] };
          stack[1].children.push(f);
          stack[1].flows.push(f);
          stack[2] = f;
        }
        stack.length = 3;
        const p = { type: "page", level: 3, id: s.id, title: s.title, summary: s.summary || "", note: s.note || "", children: [], leaves: [] };
        stack[2].children.push(p);
        stack[2].pages.push(p);
        stack[3] = p;
        stack.length = 4;
      }
      continue;
    }

    // 叶子节点
    if (!createImplicits && stack.length === 1) {
      root.children.push({ type: "leaf", step: s, container: null });
      continue;
    }
    if (stack.length === 1) ensureUngrouped();
    const module = stack[1];
    // 挂在页面下
    if (stack.length >= 4) {
      stack[3].children.push(s);
      stack[3].leaves.push(s);
    } else if (stack.length === 3) {
      // 流程下直接叶子：建隐式页面
      let p = stack[2].children.find((c) => c.implicit);
      if (!p) {
        p = { type: "page", level: 3, title: "(概述)", implicit: true, children: [], leaves: [] };
        stack[2].children.push(p);
        stack[2].pages.push(p);
      }
      p.children.push(s);
      p.leaves.push(s);
    } else {
      // 模块下直接叶子：建隐式流程+隐式页面
      let f = module.children.find((c) => c.implicit);
      if (!f) {
        f = { type: "flow", level: 2, title: "(主流程)", implicit: true, children: [], pages: [], leaves: [] };
        module.children.push(f);
        module.flows.push(f);
      }
      let p = f.children.find((c) => c.implicit);
      if (!p) {
        p = { type: "page", level: 3, title: "(概述)", implicit: true, children: [], leaves: [] };
        f.children.push(p);
        f.pages.push(p);
      }
      p.children.push(s);
      p.leaves.push(s);
    }
  }

  // 深度优先遍历叶子，赋全局序号；同时做层级校验
  const modules = root.children.filter((c) => c.type === "module");
  let globalNo = 0;
  const walkLeaf = (s) => {
    if (s.kind === "section") return;
    globalNo += 1;
    s._no = globalNo;
  };
  for (const m of modules) {
    for (const f of m.children) {
      for (const p of f.children) {
        for (const s of p.children) walkLeaf(s);
      }
    }
  }
  // 空模块/空流程检查
  for (const m of modules) {
    const leafCount = m.children.reduce(
      (acc, f) => acc + f.children.reduce((a2, p) => a2 + p.children.length, 0),
      0,
    );
    if (leafCount === 0) diagnostics.push({ level: "warn", stepId: m.id, msg: `模块「${m.title}」下没有任何操作` });
    for (const f of m.children) {
      const n = f.children.reduce((a, p) => a + p.children.length, 0);
      if (n === 0) diagnostics.push({ level: "warn", stepId: f.id, msg: `流程「${m.title} / ${f.title}」为空` });
    }
  }
  return { root, modules, diagnostics };
}

// 层级编号：模块 A/B…，流程 A.1，页面 A.1.1，叶子沿用全局连续序号
export function numberTree(tree, { startLetter = 65 } = {}) {
  tree.modules.forEach((m, mi) => {
    m.code = String.fromCharCode(startLetter + mi);
    m.flows.forEach((f, fi) => {
      f.code = `${m.code}.${fi + 1}`;
      f.pages.forEach((p, pi) => {
        p.code = `${f.code}.${pi + 1}`;
      });
    });
  });
  return tree;
}

export function leafCount(module) {
  return module.children.reduce(
    (acc, f) => acc + f.children.reduce((a, p) => a + p.children.filter((s) => s.kind !== "section").length, 0),
    0,
  );
}

// 纯文本大纲（outline 命令 / 全局推理输入）
export function outlineText(tree, { withIds = true } = {}) {
  const lines = [];
  for (const m of tree.modules) {
    const tag1 = m.implicit ? "（隐式）" : "";
    lines.push(`${m.code} 模块：${m.title}${tag1}${m.summary ? ` — ${m.summary}` : ""}`);
    for (const f of m.flows) {
      const tag2 = f.implicit ? "（隐式）" : "";
      lines.push(`  ${f.code} 流程：${f.title}${tag2}${f.summary ? ` — ${f.summary}` : ""}`);
      for (const p of f.pages) {
        const tag3 = p.implicit ? "（隐式）" : "";
        lines.push(`    ${p.code} 页面/阶段：${p.title}${tag3}${p.summary ? ` — ${p.summary}` : ""}`);
        for (const s of p.children) {
          if (s.kind === "section") continue;
          const marks = s.marks?.length ? `  [标注×${s.marks.length}]` : "";
          const id = withIds ? `#${s.id} ` : "";
          lines.push(`      ${id}${s._no}. ${s.title}${marks}`);
        }
      }
    }
  }
  return lines.join("\n");
}

// 全局快速推理用的精简索引（模块摘要 + 每模块步骤标题列表 + 锚点 id）
export function buildIndex(tree) {
  return tree.modules.map((m) => ({
    code: m.code,
    module: m.title,
    implicit: !!m.implicit,
    summary: m.summary,
    flows: m.flows.map((f) => ({
      code: f.code,
      flow: f.title,
      implicit: !!f.implicit,
      summary: f.summary,
      pages: f.pages.map((p) => ({
        code: p.code,
        page: p.title,
        implicit: !!p.implicit,
        summary: p.summary,
        steps: p.children
          .filter((s) => s.kind !== "section")
          .map((s) => ({ id: s.id, no: s._no, kind: s.kind, title: s.title, marks: (s.marks || []).length })),
      })),
    })),
  }));
}

// Mermaid mindmap（标签全部加引号，避免中文括号/特殊字符破坏语法）
export function toMermaid(tree, meta) {
  const q = (s) => `"${String(s).replaceAll('"', "'")}"`;
  const lines = ["mindmap", `  ${q(meta.title || "Playbook")}`];
  for (const m of tree.modules) {
    lines.push(`    ${q(`${m.code} ${m.title}`)}`);
    for (const f of m.flows) {
      lines.push(`      ${q(`${f.code} ${f.title}`)}`);
      for (const p of f.pages) {
        lines.push(`        ${q(`${p.code} ${p.title}`)}`);
        for (const s of p.children) {
          if (s.kind === "section") continue;
          lines.push(`          ${q(`${s._no}. ${s.title}`)}`);
        }
      }
    }
  }
  return lines.join("\n");
}
