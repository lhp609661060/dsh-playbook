#!/usr/bin/env node
// dsh-playbook 纯本地回归测试（不启动浏览器、不写真实 run）。
// 覆盖：层级树/编号、JSONL 容错、参数解析、路径相对化、registry 识别结论保留（P0 回归）。
// 用法：node scripts/selftest.mjs
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import {
  buildTree, numberTree, parseArgs, parseJsonl, toPortable, toAbs, portableMigrate,
} from "./lib.mjs";
import { regTouch, regAttachDoc, loadRegistry } from "./registry.mjs";

let passed = 0;
const fails = [];
function ok(name, cond, detail = "") {
  if (cond) { passed++; }
  else fails.push(`${name}${detail ? ` — ${detail}` : ""}`);
}
function eq(name, actual, expected) {
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// 1. 层级树：模块→流程→页面→叶子，全局编号连续
{
  const steps = [
    { id: 1, kind: "section", level: 1, title: "M" },
    { id: 2, kind: "section", level: 2, title: "F" },
    { id: 3, kind: "section", level: 3, title: "P" },
    { id: 4, kind: "note", title: "a" },
    { id: 5, kind: "note", title: "b" },
  ];
  const tree = numberTree(buildTree(steps));
  eq("tree codes", [tree.modules[0].code, tree.modules[0].flows[0].code, tree.modules[0].flows[0].pages[0].code], ["A", "A.1", "A.1.1"]);
  const leaves = tree.modules[0].flows[0].pages[0].children;
  eq("leaf global numbers", leaves.map((s) => s._no), [1, 2]);
  eq("tree diagnostics clean", buildTree(steps).diagnostics, []);
}

// 2. 隐式节点：流程前无模块 → (未分组)；页面直挂模块 → 隐式流程/页面
{
  const steps = [
    { id: 1, kind: "section", level: 2, title: "孤儿流程" },
    { id: 2, kind: "note", title: "x" },
  ];
  const t = buildTree(steps);
  ok("implicit ungrouped", t.modules[0].implicit && t.modules[0].title === "(未分组)");
  ok("diagnostic emitted", t.diagnostics.length >= 1);
}

// 3. JSONL 容错：坏行被跳过并给出行号
{
  const { steps, badLines } = parseJsonl('{"id":1}\n{bad\n\n{"id":2}\n');
  eq("jsonl good steps", steps.map((s) => s.id), [1, 2]);
  eq("jsonl bad lines", badLines, [2]);
}

// 4. parseArgs：--k v / --k=v / 单短横 -o / 布尔 / 重复 mark 聚合
{
  const a = parseArgs(["click", "@e1", "--title", "T", "-o", "/tmp/x", "--no-tree", "--formats=docx,pdf"]);
  eq("args positional", a.positional, ["click", "@e1"]);
  eq("args kv", [a.flags.title, a.flags.o, a.flags["no-tree"], a.flags.formats], ["T", "/tmp/x", true, "docx,pdf"]);
  const b = parseArgs(["--mark", "a|1", "--mark", "b|2"], { repeatKeys: ["mark"] });
  eq("repeat marks aggregated", b.flags.mark, "a|1;;b|2");
  const c = parseArgs(["scroll", "down", "-500"]);
  eq("negative number stays positional", c.positional, ["scroll", "down", "-500"]);
}

// 5. 路径相对化与还原（含搬家后按 assets 尾段回指）
{
  const run = "/data/run";
  eq("abs asset portable", toPortable("/data/run/assets/x.png", run), "assets/x.png");
  eq("outside path untouched", toPortable("/other/y.png", run), "/other/y.png");
  eq("relative abs", toAbs("assets/x.png", run), "/data/run/assets/x.png");
  eq("legacy reloc fallback", toAbs("/old/machine/run/assets/x.png", run), join(run, "assets/x.png"));
  const meta = { pageShot: `${run}/assets/shot-000-page.png` };
  const steps = [{ id: 1, shots: { before: `${run}/assets/b.png`, after: `${run}/assets/a.png` } }, { id: 2, file: `${run}/assets/f.pdf` }];
  const n = portableMigrate(meta, steps, run);
  eq("migrate count", n, 4);
  eq("meta portable", meta.pageShot, "assets/shot-000-page.png");
  eq("steps portable", steps[0].shots, { before: "assets/b.png", after: "assets/a.png" });
}

// 6. P0 回归：regTouch / backfill 不得抹掉 DOM doc 结论；换图（sha 变）才失效
{
  const dir = mkdtempSync(join(tmpdir(), "pb-reg-"));
  const assets = join(dir, "assets");
  mkdirSync(assets, { recursive: true });
  const img = join(assets, "a.png");
  writeFileSync(img, Buffer.from([1, 2, 3]));
  regTouch(dir, img); // 登记
  const doc = { title: "T", capturedAt: "now", marks: [] };
  regAttachDoc(dir, img, doc, (p, c) => writeFileSync(p, c), "dom+mark");
  ok("sidecar written", existsSync(join(assets, "a.dom.json")));
  regTouch(dir, img); // 模拟 assets --backfill 再触一次
  let e = loadRegistry(dir).files["a.png"];
  ok("P0 doc survives regTouch", !!e.doc && e.doc.source === "dom+mark", JSON.stringify(Object.keys(e)));
  ok("recognizedAt survives", !!e.recognizedAt);
  writeFileSync(img, Buffer.from([4, 5, 6, 7])); // 重拍：内容变
  regTouch(dir, img);
  e = loadRegistry(dir).files["a.png"];
  ok("doc invalidated on content change", !e.doc && !e.vision);
  rmSync(dir, { recursive: true, force: true });
}

const total = passed + fails.length;
console.log(`selftest: ${passed}/${total} passed`);
if (fails.length) {
  for (const f of fails) console.error("FAIL " + f);
  process.exit(1);
}
