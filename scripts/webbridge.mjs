// 薄适配层：把 webbridge daemon 的 HTTP API 收敛成五个原语。
// 将来换 driver（自建扩展 / 官方 browser-use seam）只改这个文件。
import { execFileSync } from "node:child_process";

const DAEMON = process.env.WEBBRIDGE_URL || "http://127.0.0.1:10086";

function tryStartDaemon() {
  const home = process.env.HOME || "";
  const candidates = [
    `${home}/.kimi-webbridge/bin/kimi-webbridge`,
    process.env.WEBBRIDGE_BIN || "",
  ].filter(Boolean);
  for (const bin of candidates) {
    try {
      execFileSync(bin, ["start"], { stdio: "ignore", timeout: 15_000 });
      return;
    } catch {
      /* try next candidate */
    }
  }
}

export async function call(action, args = {}, session = "playbook-default") {
  const body = JSON.stringify({ action, args, session });
  const doFetch = async () => {
    const res = await fetch(`${DAEMON}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error(`webbridge HTTP ${res.status}`);
    const envelope = await res.json();
    if (envelope.ok === false) {
      throw new Error(envelope.error || envelope.message || "webbridge error");
    }
    return envelope.data ?? envelope;
  };

  try {
    return await doFetch();
  } catch (err) {
    const cause = String(err?.cause?.code || err?.message || err);
    if (/ECONNREFUSED|fetch failed|HTTP 5\d\d/.test(cause)) {
      tryStartDaemon();
      await new Promise((r) => setTimeout(r, 800));
      return doFetch();
    }
    throw err;
  }
}

// --- 五个原语 ---

export const navigate = (url, { newTab = true, groupTitle, session } = {}) =>
  call("navigate", { url, newTab, group_title: groupTitle }, session);

export const snapshot = (session) => call("snapshot", {}, session);

export const click = (selector, session) => call("click", { selector }, session);

export const fill = (selector, value, session) =>
  call("fill", { selector, value }, session);

// 滚动用 evaluate 实现（webbridge 无独立 scroll 动作）
export const scroll = (direction, pixels, session) => {
  const d = String(direction).toLowerCase();
  const n = Math.max(1, Math.min(1_000_000, Math.trunc(Number(pixels) || 0)));
  const expr =
    d === "top"
      ? "window.scrollTo({top:0,behavior:'instant'})"
      : d === "bottom"
        ? "window.scrollTo({top:document.body.scrollHeight,behavior:'instant'})"
        : `window.scrollBy({left:${d === "left" ? -n : d === "right" ? n : 0},top:${d === "up" ? -n : n},behavior:'instant'})`;
  return call("evaluate", { code: `(()=>{${expr};return 'ok'})()` }, session);
};

export const evalJs = (code, session) => call("evaluate", { code }, session);

export const screenshot = (path, session, { format = "png", quality = 85 } = {}) =>
  call("screenshot", format === "jpeg" ? { format, quality, path } : { format, path }, session);
