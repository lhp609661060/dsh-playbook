# Changelog

## 0.4.0 — 首次开源发布

- 以 MIT 许可证开源；新增中英双语 README（README.md / README.en.md）、LICENSE、.gitignore。
- 新增完全虚构、手工构造的示例 run（`examples/bookshelf-demo/`，使用 RFC 2606 保留域名 `example.invalid`），不包含任何真实业务数据。
- daemon 地址支持 `WEBBRIDGE_URL` 环境变量覆盖（默认仍为 `http://127.0.0.1:10086`）。
- 与企业内部录制相关的私有运行记录不纳入公开仓库。

## 0.3.1 — 多维度可靠性修复

- **P0 修复：识别结论不再被静默抹掉。** `regTouch`（`assets --backfill`、`see`、重拍同哈希等路径都会调用）
  此前重建 registry 条目时只保留 `vision`、丢失 `doc`，会把 DOM 文档识别结论清零、sidecar 变孤儿。
  现在同 sha 下 `doc`/`vision`/`recognizedAt` 全部原样继承，仅内容变化（重拍）才失效。registry 逻辑独立为 `scripts/registry.mjs`。
- **P1：`check` 补两类漏检。** registry 中没有条目的交付图也算未识别；新增 `missingFiles`（引用存在但磁盘缺失的图）；
  `scroll` 步骤纳入结果图检查。
- **P1：run 目录可移植。** steps/meta 的资产路径改为相对 run 目录；新增 `migrate` 命令对旧 run 做一次性迁移，
  读取旧绝对路径时若文件已随目录搬家，按 `assets/<name>` 尾段自动回指。
- **P2：参数解析统一**（`lib.parseArgs`，record/assemble/export/preview 共用）：同时支持 `--k v`、`--k=v`、`-o v`。
  修复 export 的 `-o` 被忽略（html 误写进 run 目录）、preview 的 `--no-embed` 实际仍内嵌 dataURI 两个问题。
- **P2：steps.jsonl 单行损坏不再让整条命令崩溃**，报行号并跳过。
- **P2：标注器与文档识别的页内解析器去重**，统一为 `lib.PAGE_JS_HELPERS`（交互元素→XPath→叶子文本，两处行为完全一致）。
- **P3：动作命令新增 `--wait <ms>` 与 `--no-tree`**（可配置等待、按需回传 AX tree）。
- **P3：危险动作闸门**——保存/提交/删除/确认等选择器或标题、以及 eval 中的 POST/PUT/DELETE 特征，
  未经 `--allow-danger`（或 `PLAYBOOK_ALLOW_DANGER=1`）拒绝执行。
- 新增 `scripts/selftest.mjs`（22 项纯本地回归）与「实战踩坑」章节。

## 0.3.0

- 图片识别改为 **DOM 文档优先、视觉只做核验**：`mark`/`--mark` 截图时自动抽取标注元素真实文字/值/坐标与页面结构，
  落 `.dom.json` sidecar + registry 紧凑摘要；新增 `doc`/`see`/`assets` 命令与 sha256 缓存。
- `text=` 解析器优先可交互元素，修复按钮文字与图标同处一个非叶子 span 时误框说明段落。
- el-table 固定列克隆表头去重、隐藏输入域过滤；状态一致性红线（不得把当前 DOM 错挂到历史截图）。
