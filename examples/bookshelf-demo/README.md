# bookshelf-demo — 虚构示例 / Fictional example

**中文：** 这是一个**完全虚构、手工编写**的示例 run，用于说明 dsh-playbook 的录制数据与产物格式：

- 系统为虚构的"书架管理后台"，域名 `demo.example.invalid` 取自 RFC 2606/6761 保留域名，不解析、不指向任何真实系统；
- `assets/` 下为程序生成的占位图，不是真实截图；
- 不含任何真实账号、业务数据或内网地址。

**English:** This is a **fully fictional, hand-crafted** demo run illustrating dsh-playbook's recording data and output format:

- The system is a made-up "bookshelf admin console" on the reserved domain `demo.example.invalid` (RFC 2606/6761); it never resolves.
- Images under `assets/` are generated placeholders, not real screenshots.
- No real accounts, business data, or intranet addresses are included.

重新生成 / regenerate:

```sh
node ../../scripts/assemble.mjs . -o bookshelf-demo.md
```
