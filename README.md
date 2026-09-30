# dsh-playbook

> 网页操作文档（SOP / 操作手册 / Runbook）**录制与生成器**——把一次真实的网页操作过程，录成**分层、可维护、带红框标注图**的操作文档。
>
> English README: [README.en.md](README.en.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

给一个 URL，dsh-playbook 会：

1. 分析页面，提出 **模块 → 流程 → 页面 → 操作** 的层级化操作流；
2. 通过浏览器扩展在**真实页面**上边操作边录制（动作、选择器引用、前后截图、**红框元素标注**、步骤说明）；
3. 提供思维导图式交互预览，支持随时在聊天中按节点补充 / 纠正（局部改动只做子树推理）；
4. 一键产出分层编号、带目录与标注图的 **Markdown / Word / PDF** 操作文档。

## 特性

- **四层文档模型**：模块 → 流程 → 页面 → 操作，不是平铺的步骤清单；
- **红框自动标注**：关键元素自动框选、分配 7 色编号、顶部生成图例，读者不用在整页截图里自己找；
- **DOM 文档优先识别**：标注时自动抽取元素真实文字 / 值 / 坐标与页面结构，零视觉 token；
- **危险动作闸门**：保存 / 提交 / 删除 / 发布等写操作默认拦截，需显式 `--allow-danger` 才执行；
- **零 npm 依赖**：脚本仅使用 Node.js 内置模块；
- **多格式导出**：Markdown / docx（pandoc）/ PDF（wkhtmltopdf）；
- **可增量维护**：改某一节点只补录子树，再做一次全局快速校验，无需全量重录。

## 工作流总览

```
结构设计 → 分析(snap) → 录制(click/fill/mark…) → 预览/协同改动 → 成文导出(assemble + export)
```

## 安装

### 1. 获取本仓库

```sh
git clone https://github.com/lhp609661060/dsh-playbook.git
```

### 2. 前置依赖

| 依赖 | 必需性 | 说明 |
| --- | --- | --- |
| **Node.js** ≥ 18 | 必需 | 脚本全部为零依赖的 `.mjs`，仅用 Node 内置模块 |
| **Kimi Browser Extension**（含本地 daemon，默认 `http://127.0.0.1:10086`） | 录制时必需 | 用来操控你的**真实浏览器**、复用登录态；也可通过 `WEBBRIDGE_URL` 指向兼容 daemon |
| pandoc | 导出 docx 时需要 | `brew install pandoc` |
| wkhtmltopdf | 导出 PDF 时需要 | `brew install wkhtmltopdf` |

> dsh-playbook 本身只负责**编排 / 录制 / 推理 / 成文**，浏览器控制统一由浏览器扩展的本地 daemon 完成。
> daemon 地址可用环境变量覆盖：`export WEBBRIDGE_URL=http://127.0.0.1:10086`。

### 3. 作为 DeepSeek Harness 技能使用

将本目录放到 DSH 的技能目录（或软链），技能定义见 [`SKILL.md`](SKILL.md)。DSH 会在匹配到「操作文档 / SOP / 操作手册 / runbook」等意图时自动加载。

## 快速开始

```sh
# 0) 结构设计：先让助手分析页面并给出「模块→流程→页面」候选结构，确认后再录

# 1) 建 run、打开页面
node scripts/record.mjs start "https://example.com" --title "示例任务"

# 2) 查看页面无障碍快照（@e 编号用于引用元素）
node scripts/record.mjs snap

# 3) 声明层级节点并录制操作
node scripts/record.mjs section --level 1 --title "登录与进入系统" --summary "登录并进入目标功能"
node scripts/record.mjs section --level 2 --title "账号密码登录"
node scripts/record.mjs section --level 3 --title "登录页"
node scripts/record.mjs fill "@e17" "账号" --title "输入账号"
node scripts/record.mjs click "@e21" --title "提交登录" --before

# 4) 红框标注（重点元素一律标注）
node scripts/record.mjs mark 'text=保存|提交按钮' --title "关键元素说明"

# 5) 思维导图预览（AI 推理 / 用户协同）
node scripts/preview.mjs

# 6) 结构诊断
node scripts/record.mjs outline
node scripts/record.mjs check

# 7) 成文与导出
node scripts/assemble.mjs ./playbook-runs/example/
node scripts/export.mjs ./playbook-runs/example/   # 默认 docx + pdf
```

> 完整命令与参数（`--before / --mark / --wait / --no-tree / --allow-danger / mv / amend / insert / drop / reshoot / doc / see / migrate` 等）见 [`SKILL.md`](SKILL.md)。

## 示例

[`examples/bookshelf-demo/`](examples/bookshelf-demo/) 是一个**完全虚构、手工构造**的迷你 run（虚构的"书架管理后台"，域名使用 RFC 2606 保留的 `example.invalid`），包含：

- `meta.json` / `steps.jsonl`：录制数据；
- `assets/`：占位截图；
- `bookshelf-demo.md`：由 `assemble.mjs` 生成的成品手册。

可直接重新生成：

```sh
node scripts/assemble.mjs examples/bookshelf-demo -o examples/bookshelf-demo/bookshelf-demo.md
```

## 安全边界

- 浏览器操作只走扩展 daemon，不另启浏览器、不碰其他标签页（session 隔离）；
- **危险动作闸门**：选择器 / 标题命中 保存、提交、确定、删除、清空、重置、发布、作废 等，或 eval 中出现 POST/PUT/DELETE 特征时，命令默认拒绝；确需执行须加 `--allow-danger`（或设 `PLAYBOOK_ALLOW_DANGER=1`）；
- 标注层是注入页面的临时 DOM，截图后自动移除；临时 `data-pb-*` 属性截完即清理。

## 脚本测试

```sh
node scripts/selftest.mjs   # 纯本地、不需要浏览器；22 项回归
```

## 目录结构

```
dsh-playbook/
├── SKILL.md              # DSH 技能定义与完整工作流（核心文档）
├── README.md / README.en.md
├── CHANGELOG.md
├── LICENSE
├── scripts/
│   ├── record.mjs        # 录制 CLI（start/snap/动作/section/mark/mv/amend…）
│   ├── assemble.mjs      # run → 分层 Markdown
│   ├── export.mjs        # run → docx/pdf/html/md
│   ├── preview.mjs       # 交互式思维导图 HTML / Mermaid / 索引
│   ├── registry.mjs      # 截图 sha256 识别缓存
│   ├── webbridge.mjs     # 浏览器扩展 daemon 客户端
│   ├── lib.mjs
│   └── selftest.mjs
├── templates/playbook.md
└── examples/bookshelf-demo/
```

## 许可证

[MIT](LICENSE) © 2026 lhp609661060
