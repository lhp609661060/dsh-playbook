---
name: dsh-playbook
description: |
  网页操作文档（SOP/操作手册）录制与生成插件。用户给出 URL 后，先分析页面并提出「模块 → 流程 → 页面 → 操作」层级化操作流，
  再通过 kimi-webbridge 在真实页面上边操作边录制（动作、AX 引用、前后截图、红框元素标注、步骤说明），
  支持思维导图式交互式预览（逐层浏览、搜索、详情、一键生成改动口令），用户可随时在聊天中按节点补充/纠正，
  局部改动只做子树推理，再做一次全局快速校验，最终一键产出分层编号、带目录与标注图的 Markdown 操作文档。
  匹配词：操作文档、操作手册、SOP、playbook、录步骤、页面操作说明、教程文档、网页教程、runbook、思维导图。
metadata:
  version: "0.4.0"
  requires:
    skill: ["kimi-webbridge"]
    daemon: "http://127.0.0.1:10086"
---

# dsh-playbook — 网页操作文档录制器（模块层级 + 标注 + 思维导图预览）

把一次真实的网页操作过程录成**分层、可维护、带红框标注**的操作文档。浏览器控制统一走
[kimi-webbridge](http://127.0.0.1:10086)（复用用户登录态），本 skill 只负责**编排、录制、推理、成文**。

## 文档模型（先想清楚再动手）

操作不是平铺步骤，而是四层：

```
模块(level 1)   如：登录与进入系统、数据维护、收尾与注意事项   —— 一个可独立讲解的业务块
 └─流程(level 2) 如：账号密码登录、SSO 登录                   —— 完成一件事的完整路径
   └─页面/阶段(3) 如：登录页、首页                            —— 一个界面或一个明确阶段
     └─操作(叶子) goto/click/fill/eval/shot/note            —— 具体到页面元素的动作
```

- 模块回答"这件事分几大块"；流程回答"有哪几种业务路径"；页面回答"现在在哪、界面有什么"；
  操作回答"点哪个按钮、填什么值、预期出现什么"。
- 一个模块可含多个流程（如登录模块含账号登录 / SSO 登录 / 找回密码）；同一页面上的多个操作归入同一页面节点。
- 登录、权限、通用注意事项这类跨页面内容，**独立成模块**，不要散在业务步骤里。

## 产物目录结构

每个任务一个 run 目录（默认 `./playbook-runs/<slug>/`，`--dir` 可改）：

```
playbook-runs/<slug>/
├── meta.json                  # url、标题、session、schemaVersion
├── steps.jsonl                # section 节点 + 操作步骤混排，按物理顺序确定归属
├── assets/                    # 截图（实拍图与红框标注图）+ .registry.json 识图缓存（按 sha256）
├── <slug>.md/.docx/.pdf       # 最终操作手册（assemble + export 生成，默认交付 docx+pdf）
└── .playbook-internal/        # 内部辅助产物，不进交付包（用户要时可单独提供 preview.html）
    ├── <slug>.preview.html    #   单文件交互式思维导图（AI 推理 / 用户预览）
    ├── <slug>.mmd             #   Mermaid mindmap
    └── <slug>.index.json      #   精简结构索引（全局快速推理输入）
```

## 工作流（五阶段）

### 0. 结构设计（必做，先于录制）

打开页面后先产出候选结构（不必精确，随录制修正），在聊天里给用户确认：

```
A 登录与进入系统
  A.1 账号密码登录
    A.1.1 登录页（输入账号/密码 → 登录）
    A.1.2 首页（确认登录成功）
  A.2 功能菜单导航
B ……（业务模块，按实际页面设计）
```

### 1. 分析（analyze）

```sh
node "$PLAYBOOK_DIR/scripts/record.mjs" start <url> --title "任务标题"
node "$PLAYBOOK_DIR/scripts/record.mjs" snap            # 打印页面 AX 快照（@e 引用）
```

- 用快照读懂区域、可交互控件、前置条件；在聊天中给出候选层级结构 + 每步预期结果，认可后再录。
- 一次任务全程同一个 webbridge session（脚本自动生成 `playbook-<slug>`，不要中途换）。

### 2. 录制（record）

**先声明模块/流程/页面，再录属于它的操作**（后续操作自动归入当前节点；遇到同级或更高级 section 自动切换）：

```sh
# 层级节点：--level 1=模块 2=流程 3=页面/阶段；--summary 一句话概述（显示在思维导图与目录）
node scripts/record.mjs section --level 1 --title "登录与进入系统" --summary "登录并进入目标功能"
node scripts/record.mjs section --level 2 --title "账号密码登录"
node scripts/record.mjs section --level 3 --title "登录页" --summary "输入账号密码"
# 忘记在某位置声明时，用 --after N 把 section 插到第 N 条之后；或录完用 mv 调整归属

# 操作（--title 是文档里的步骤标题，必填；--note 是写给读者的说明）
node scripts/record.mjs fill "@e17" "账号" --title "输入账号"
node scripts/record.mjs click "@e21" --title "提交登录" --before
node scripts/record.mjs scroll down 600 --title "查看下方分页"
node scripts/record.mjs eval --code '(async()=>{...})()' --title "展开多级菜单"  # AX 树覆盖不到浮层时的退路
node scripts/record.mjs note --title "前置条件" --note "需要 XX 权限"
node scripts/record.mjs shot --title "下拉展开状态"
```

动作命令的通用开关：

- `--wait <ms>`：动作后等待毫秒数（默认 700，eval 800，goto 1000）；内网慢加载/动画长时调大，避免截到加载中。
- `--no-tree`：本步不回传整棵 AX tree（连续机械操作时省 token；需要读结构时不加）。
- `--allow-danger`：危险动作闸门见「边界与安全」。

#### 红框标注（重点元素一律标注，而不是全页截图让读者自己找）

```sh
# 独立标注截图（无页面动作），可多个目标；格式 "选择器|标签文字"
node scripts/record.mjs mark '.year-picker|年份选择器' 'text=未维护|未维护状态' --title "关键元素说明" --note "图中①②③分别是……"
# 给已有步骤重拍/替换为标注图：
node scripts/record.mjs mark 'text=保存|提交按钮' --step 9
# 操作动作同时标注结果页元素：click/fill/eval/goto 直接加 --mark（多个用多个 --mark）
node scripts/record.mjs click "@e5" --title "打开编辑" --mark 'text=保存|保存按钮出现'
```

定位方式（按可靠性优先）：

1. 快照 `@e` 引用；CSS 选择器（`text=` **先匹配可交互元素**——按钮文字常与图标同处一个非叶子 span，
   只查叶子会撞到包含该词的说明段落；叶子文本匹配留给表头 `.cell`/label）。
2. **宽表格/固定列（el-table sticky/fixed 列）下 `nth-child` 与视觉列可能错位**：
   先 `eval` 给目标元素临时打 `data-pb-xxx` 属性，用 `[data-pb-xxx]` 标注，截完移除属性。
3. 标注器自动：按编号分配 7 色、顶部生成图例条（标签不互相遮挡）、目标加数字角标、纵向滚动带入视口。
   **绝不横向滚动**（会破坏固定列表格的坐标对齐）。`check` 会报告未命中的标注。

截图策略：

- 默认拍操作后图；关键/危险操作加 `--before`。
- **能用一张标注图讲清的，不要堆全页图**：标注聚焦"点这里/填这里/结果在这里"。
- 页面整体布局才用无标注全景图；标注图替代该步骤的普通截图（`--step N` 会替换主图，旧图保留 assets）。
- **标注图截完自动做 DOM 文档识别（标注元素真实文字/坐标 + 页面结构），不需要 read_image**；
  只有命令行提示标注未命中/不在视口、或怀疑框位错位时才看一眼图核验。

### 2.5 图片识别：DOM 文档优先，视觉只做核验（每张图只识别一次）

截图里的内容本来就在页面 DOM 里——**识别一律先读文档（DOM），不要默认 read_image**：

1. **文档识别（默认、零视觉 token）**：标注截图（`mark`/`--mark`）在标注层还在时自动抽取
   每个标注元素的真实文字/值/placeholder/坐标，并连同页面标题、面包屑、按钮清单、表格表头与行数、
   业务卡片等结构化信息一起登记；普通截图在"录制时的同一页面状态"下用
   `doc --step N` 或 `doc --asset 文件名` 补登。结果落两份：
   - `assets/<图名>.dom.json`：完整结构化文档（成文/答疑直接读）；
   - `assets/.registry.json` 该图的 `doc`：紧凑摘要（按钮/表头/标注命中文字等）。
   **结合页面功能（步骤标题 + 该页能做什么）就能写出标注说明，不必看图。**
2. **视觉只在这些情况兜底**：① DOM 回不到录制状态（弹窗已关、历史数据被改/被清，如切年后旧年份数据）；
   ② 需要核验像素布局（框是否遮挡、颜色/图标）；③ canvas/图片型/跨域内容。视觉结论用 `see` 登记。
3. **状态一致性红线**：`doc` 前确认浏览器停在截图时的同一状态（年份/月份/只读或编辑中/弹窗）；
   不可复现的旧图宁可用 `see`，不要把"现在的 DOM"错挂到"过去的图"上。
4. 每张截图落盘都按 sha256 登记；重拍/换图哈希变化，旧结论自动作废才需重新识别。
   `assets` 显示每张图的识别来源（`dom`/`dom+mark`/`vision`）与 `unseen`；`check` 的
   `unrecognizedShots` 列出尚未识别的交付图，成文前必须清零。

### 3. 预览与协同改动（思维导图，内部辅助产物）

```sh
node "$PLAYBOOK_DIR/scripts/preview.mjs" <run目录>   # 默认生成 .playbook-internal/<slug>.preview.html
# 需要交给用户时加 -o 显式输出到交付位置；--mermaid/--json 同目录
```

> 思维导图/业务流程图是**给 AI 做结构推理、给用户在协同阶段看的辅助产物，默认不进交付包**；
> 用户明确想要时再单独提供（preview.html 图片内嵌、可独立分发）。

预览页（纯本地 HTML，双击即开）能力：

- **思维导图视图**：模块→流程→页面→操作逐层折叠；可选"只看模块/展开到流程/页面/全部"；关键词搜索高亮。
- **业务流程视图**：按模块分泳道、流程分列、页面分块的顺序视图。
- 点任意节点看详情：完整说明、操作前后截图、标注图例、选择器/填写值等录制信息。
- 每个节点带「＋ 让 AI 在此节点下补充 / ✎ 让 AI 修改」按钮，一键复制**带节点坐标的改动口令**，
  用户贴回聊天即可，无需描述"第几节第几页"。

### 4. 两级推理协议（改动时严格执行，避免全量重录、也避免改乱结构）

用户通过口令或自然语言提出改动后：

1. **定位节点**：从口令中的 `模块/流程/页面 code`（A.1.2）或 `步骤 #id` 唯一定位子树；先看 `outline` 确认。
2. **局部推理（只动子树）**：
   - 改节点下的内容只影响该节点；需要新操作时，把浏览器停到对应页面，只补录这几步（`mark --step` / `insert` / `section --after` / `mv`）。
   - 重排用 `mv <id> --after N` 或 `--section <sectionId>`；删用 `drop`；改文案用 `amend`；重拍用 `reshoot/mark --step`。
   - 局部步骤的**叶子全局序号会自动重排**（序号是成文时算的，不是手工编号）。
3. **全局快速推理（一次轻量校验）**：改完跑 `outline` + `check`，只核对四件事，不重读全部页面：
   - 结构：有没有空模块/空流程、叶子是不是都挂在正确的页面下（diagnostics）；
   - 顺序：业务路径是否仍连贯（如"取消"是否还在"编辑"之后）；
   - 引用：被删/移动步骤有没有让别的说明指代失效；编号/目录变化点列给用户；
   - 资产：每张标注图是否仍命中（`missingMarkShots`）、每个动作是否有结果图（`stepsWithoutAfterShot`）。
4. 只有全局校验发现跨模块影响（如登录方式变了导致后续模块前置条件失效）时，才扩大推理范围，
   并明确告诉用户影响了哪些模块。

```sh
node scripts/record.mjs outline          # 打印层级大纲（含每个叶子的 #id 与标注数）
node scripts/record.mjs check            # 空节点 / 标注未命中 / 缺结果图 诊断
```

### 5. 成文与导出（默认交付 Word + PDF）

```sh
node "$PLAYBOOK_DIR/scripts/assemble.mjs" <run目录>          # 先生成 <slug>.md（中间稿，也可交付）
node "$PLAYBOOK_DIR/scripts/export.mjs  <run目录>           # 默认导出 docx + pdf（同名，图片内嵌）
# 其他格式：--formats docx,pdf,html,md  或  --name/-o 输出目录 ；用户也可在聊天里指定要的格式
```

- assemble：模块 `## A` / 流程 `### A.1` / 页面 `#### A.1.1`，步骤全局连续编号，自动目录；
  标注图上方自动加「图中标注：①…②…」图例。
- export：Word 用 pandoc（GFM→docx，带目录，图片内嵌）；PDF 用自包含 HTML（图片转 dataURI）→ wkhtmltopdf，
  A4、分页友好。缺工具时给出安装提示并跳过对应格式。
- **默认交付 `.docx` + `.pdf`**（附 `.md` 源稿）；思维导图 `.playbook-internal/` 不打包。
  用户在聊天里要 html / 仅 md / 其他格式时按要求导出。
- 没有 section 的旧 run 自动退化为平铺文档（隐式节点不输出标题），**完全向后兼容**。
- 模板 `templates/playbook.md`（token：TITLE/URL/TOC/STEPS/APPENDIX 等），可按团队风格改。

## 全部命令速查

| 命令 | 作用 |
| --- | --- |
| `start <url> --title` | 建 run、开页、拍页面概览图 |
| `snap [--save]` | 打印 AX 快照 |
| `goto/click/fill/scroll/eval` | 执行并录制动作（`--title/--note/--before/--mark/--no-shot/--wait/--no-tree/--allow-danger`） |
| `note/shot` | 纯说明 / 纯截图步骤（均支持 `--after N`） |
| **`section --level 1\|2\|3 --title [--summary --note --after N]`** | 声明模块/流程/页面 |
| **`mark "选择器\|标签" ... --title [--step N] [--after N]`** | 红框标注截图（新建或替换某步主图） |
| `unmark` | 手动清除页面上残留的标注层 |
| **`mv <id> --after N` / `--section <sectionId>`** | 移动步骤到指定位置/节点 |
| **`outline` / `check`** | 层级大纲 / 结构与标注诊断 |
| **`doc --step N` / `doc --asset 图名`** | **DOM 文档识别（首选）**：抽页面/表格/按钮/标注元素的真实文字与坐标，写入 `.dom.json` + registry |
| **`see <id\|图名> --desc [--ocr --el]`** | 登记视觉识图结论（DOM 回不到录制状态时的兜底；sha256 缓存） |
| **`assets [--backfill]`** | 资产清单：识别来源 dom / vision、哪些图还没识别 |
| `amend N --title/--note/--summary` | 改文案（section 可改 summary） |
| `insert N note\|shot` / `drop N` / `reshoot N` | 插入 / 删除 / 重拍 |
| `attach <文件> --title [--after N]` | 外部图片/文档归入步骤或附录 |
| `migrate` | 旧 run 一次性迁移：资产绝对路径转相对（run 目录可整体搬迁） |

全部命令都可用 `--dir <run目录>` 显式指定 run；默认从 cwd 向上自动发现。

改脚本后先跑 `node "$PLAYBOOK_DIR/scripts/selftest.mjs"`（纯本地，不需要浏览器），22 项全绿再用于真实录制。

## 边界与安全

- 只通过 webbridge 操作浏览器；不另启 Chrome、不碰用户其他 tab（session 隔离）。
- 关闭标签页/会话必须用户明确要求；录制结束不要自动 `close_session`。
- **危险动作闸门（工具层兜底）**：`click`/`eval` 的选择器或标题命中 保存/提交/确定/确认/删除/移除/清空/重置/覆盖/发布/作废
  或 `.danger`、POST/PUT/DELETE 请求特征时，命令直接拒绝执行；确需执行（用户已明确授权、或纯演示环境）加
  `--allow-danger`，或设环境变量 `PLAYBOOK_ALLOW_DANGER=1`。闸门之外，录制前仍要先与用户约定边界（如"只录入不保存"），
  危险动作在 `--note` 写明后果；默认做法是只截入口图 + 文字说明预期结果。
- 标注层是注入页面的临时 DOM，截图后自动移除；用临时 `data-pb-*` 属性定位时截完务必清理。
- 严格校验 `event.isTrusted` 的站点（部分银行/验证码）合成事件无效，需用 `cdp` 通道或请用户手动操作，
  文档标注「此步需人工」。跨域 iframe：导航到 iframe 自身 URL 再操作。

## 实战踩坑（element-plus / 内网系统，遇到再查）

- **el-table 固定列/克隆表头**：sticky/fixed 列会生成克隆的 header/body 表，`nth-child` 与视觉列可能错位；
  文档识别已按列签名去重；标注这类单元格优先 `eval` 临时打 `data-pb-*` 再用 `[data-pb-*]`，截完清理。
- **按钮文字与图标同在一个非叶子 span**：`text=保存` 必须由解析器优先匹配 button/.el-button 等可交互元素
  （已内置），否则会框到含该词的说明段落；叶子文本匹配只用于表头 `.cell`/label。
- **日期/年份选择器打不开**：合成 `.click()` 有时无效，用 `cdp` 的 `Input.dispatchMouseEvent`（pressed/released）
  在输入框中心点可信点击；面板单元格高度为 0 时改用 `Input.dispatchKeyEvent`（Ctrl+A→Backspace→数字→回车）录值。
- **连接池被挂起的同源 fetch 占满**：页面 `evaluate` 里手写的同源 fetch 挂起后，后续点击可能卡在 loading mask、
  无 XHR 发出；用 `navigate <url>` 配 `newTab` 开新标签恢复，不要反复点同一个卡住的控件。
- **中文文本没有 `\\b` 词边界**：如「3已维护」不会被 `/^\\s*3\\b/` 命中，按 `.textContent === '3'` 之类精确匹配。
- **run 目录可整体搬迁**：steps/meta 内资产路径存相对路径；旧 run（绝对路径）跑一次
  `node scripts/record.mjs migrate --dir <run>` 即可。
