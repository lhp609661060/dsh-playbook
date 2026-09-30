// dsh-playbook 资产登记表：每张图一次识别、按 sha256 缓存，内容变了自动失效。
// 一个条目可同时携带 doc（DOM 文档识别）与 vision（视觉兜底）结论；
// 任何重建条目的路径都必须完整保留两者——曾出现过 regTouch 只保留 vision、
// 把 DOM 识别结论静默抹掉的 P0 缺陷。
import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

export function registryPath(dir) {
  return join(dir, "assets", ".registry.json");
}

export function loadRegistry(dir) {
  try {
    return JSON.parse(readFileSync(registryPath(dir), "utf8"));
  } catch {
    return { version: 1, files: {} };
  }
}

export function saveRegistry(dir, reg) {
  writeFileSync(registryPath(dir), JSON.stringify(reg, null, 2) + "\n");
}

export function hashFile(p) {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

// 截图落盘后登记；文件内容没变（同 sha）则 doc/vision 两个识别结论与时间戳全部保留；
// 内容变了（重拍/替换）才让旧结论作废。
export function regTouch(dir, file) {
  if (!file || !existsSync(file)) return;
  const reg = loadRegistry(dir);
  const name = basename(file);
  const sha = hashFile(file);
  const prev = reg.files[name];
  const same = prev && prev.sha256 === sha;
  const entry = {
    sha256: sha,
    bytes: statSync(file).size,
    registeredAt: prev?.registeredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (same) {
    // 同一文件：识别结论与识别时间戳原样继承，绝不丢字段
    if (prev.doc) entry.doc = prev.doc;
    if (prev.vision) entry.vision = prev.vision;
    if (prev.recognizedAt) entry.recognizedAt = prev.recognizedAt;
  }
  reg.files[name] = entry;
  saveRegistry(dir, reg);
}

// 文档识别结果落盘：完整 sidecar（assets/<name>.dom.json）+ registry 内紧凑摘要
export function regAttachDoc(dir, imgPath, doc, sidecarWrite, source = "dom") {
  if (!imgPath || !existsSync(imgPath)) return;
  regTouch(dir, imgPath);
  const reg = loadRegistry(dir);
  const name = basename(imgPath);
  const entry = reg.files[name];
  const sidecar = imgPath.replace(/\.(png|jpe?g|gif|webp)$/i, ".dom.json");
  sidecarWrite(sidecar, JSON.stringify(doc, null, 2) + "\n");
  const compact = {
    source,
    pageTitle: doc.title || "",
    url: doc.url || "",
    headings: doc.headings || [],
    menus: doc.menus || [],
    buttons: (doc.buttons || []).map((b) => b.text + (b.disabled ? "(禁用)" : "")),
    inputs: (doc.inputs || []).map((i) => (i.placeholder || i.name || "输入框") + "=" + (i.value || "空")),
    cards: (doc.cards || []).map((c) => c.text),
    tables: (doc.tables || []).map((t) => `${t.columns.length}列/${t.rowCount}行: ` + t.columns.join("|")),
    marks: (doc.marks || []).map((m) => m.found ? `${m.index}.${m.label}「${m.text || m.placeholder}」@(${m.box.x},${m.box.y})` : `${m.index}.${m.label}[未命中]`),
    notes: (doc.notes || []).map((n) => n.text),
    docAt: doc.capturedAt || new Date().toISOString(),
    sidecar: basename(sidecar),
  };
  entry.doc = compact;
  entry.recognizedAt = new Date().toISOString();
  reg.files[name] = entry;
  saveRegistry(dir, reg);
  return { sidecar, compact };
}
