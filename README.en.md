# dsh-playbook

> A recorder and generator for web operation documents (SOPs / operation manuals / runbooks).
> It records a real walk-through of a web app and turns it into a **hierarchical, maintainable manual with red-box annotated screenshots**.
>
> 中文文档：[README.md](README.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Given a URL, dsh-playbook can:

1. Analyze the page and propose a hierarchical operation flow: **Module → Flow → Page → Action**;
2. Record your work on the **real page** through a browser extension (actions, selector refs, before/after screenshots, **red-box annotations**, step notes);
3. Provide an interactive mind-map preview and let you amend individual nodes in chat at any time (subtree-only reasoning);
4. Produce a numbered **Markdown / Word / PDF** manual with a TOC and annotated figures in one command.

## Features

- **Four-layer document model**: module → flow → page → action, instead of a flat step list;
- **Automatic red-box annotation**: key elements are boxed and assigned 7-color numbers with a legend, so readers don't hunt through full-page screenshots;
- **DOM-first recognition**: annotations automatically capture real text / values / coordinates and page structure — zero vision tokens;
- **Dangerous-action guard**: write actions such as save / submit / delete / publish are blocked by default and require an explicit `--allow-danger`;
- **Zero npm dependencies**: the scripts use Node.js built-in modules only;
- **Multi-format export**: Markdown / docx (pandoc) / PDF (wkhtmltopdf);
- **Incremental maintenance**: re-record only the affected subtree, then run one fast global check — no full re-recording.

## Workflow

```
structure design → analyze(snap) → record(click/fill/mark…) → preview / co-edit → assemble + export
```

## Installation

### 1. Get the repository

```sh
git clone https://github.com/lhp609661060/dsh-playbook.git
```

### 2. Prerequisites

| Dependency | Required | Notes |
| --- | --- | --- |
| **Node.js** ≥ 18 | Yes | All scripts are dependency-free `.mjs` files using Node built-ins |
| **Kimi Browser Extension** (local daemon, default `http://127.0.0.1:10086`) | For recording | Drives your **real browser** and reuses your login sessions; you can point `WEBBRIDGE_URL` to any compatible daemon |
| pandoc | For docx export | `brew install pandoc` |
| wkhtmltopdf | For PDF export | `brew install wkhtmltopdf` |

> dsh-playbook only handles orchestration / recording / reasoning / authoring; browser control is delegated to the extension's local daemon.
> Override the daemon address with `export WEBBRIDGE_URL=http://127.0.0.1:10086`.

### 3. Use as a DeepSeek Harness skill

Place this directory (or symlink it) in your DSH skills directory. The skill definition lives in [`SKILL.md`](SKILL.md). DSH auto-loads it when the intent matches "operation document / SOP / manual / runbook".

## Quick start

```sh
# 0) Structure design: have the assistant analyze the page and propose a
#    Module → Flow → Page draft; confirm it before recording

# 1) Create a run and open the page
node scripts/record.mjs start "https://example.com" --title "Demo task"

# 2) Read the accessibility snapshot (@e numbers reference elements)
node scripts/record.mjs snap

# 3) Declare hierarchy nodes and record actions
node scripts/record.mjs section --level 1 --title "Login & entry" --summary "Log in and enter the feature"
node scripts/record.mjs section --level 2 --title "Password login"
node scripts/record.mjs section --level 3 --title "Login page"
node scripts/record.mjs fill "@e17" "alice" --title "Enter account"
node scripts/record.mjs click "@e21" --title "Submit login" --before

# 4) Red-box annotation (annotate key elements)
node scripts/record.mjs mark 'text=Save|Submit button' --title "Key elements"

# 5) Mind-map preview (AI reasoning / user co-editing)
node scripts/preview.mjs

# 6) Structure diagnostics
node scripts/record.mjs outline
node scripts/record.mjs check

# 7) Assemble and export
node scripts/assemble.mjs ./playbook-runs/demo/
node scripts/export.mjs ./playbook-runs/demo/   # default: docx + pdf
```

> See [`SKILL.md`](SKILL.md) for the full command reference (`--before / --mark / --wait / --no-tree / --allow-danger / mv / amend / insert / drop / reshoot / doc / see / migrate`, etc.).

## Example

[`examples/bookshelf-demo/`](examples/bookshelf-demo/) is a **fully fictional, hand-crafted** mini run (a made-up "bookshelf admin console" using the RFC 2606 reserved domain `example.invalid`). It contains:

- `meta.json` / `steps.jsonl`: recorded data;
- `assets/`: placeholder screenshots;
- `bookshelf-demo.md`: the assembled manual.

Regenerate it with:

```sh
node scripts/assemble.mjs examples/bookshelf-demo -o examples/bookshelf-demo/bookshelf-demo.md
```

## Safety boundaries

- Browser actions go through the extension daemon only — no separate browser, no other tabs (session isolation);
- **Dangerous-action guard**: selectors / titles matching save, submit, confirm, delete, clear, reset, publish, void, etc., or POST/PUT/DELETE patterns inside eval, are rejected by default; use `--allow-danger` (or set `PLAYBOOK_ALLOW_DANGER=1`) when explicitly authorized;
- The annotation layer is temporary DOM injected into the page and removed after capture; temporary `data-pb-*` attributes are cleaned up immediately.

## Script tests

```sh
node scripts/selftest.mjs   # fully local, no browser needed; 22 regression checks
```

## Layout

```
dsh-playbook/
├── SKILL.md              # DSH skill definition & complete workflow (core doc)
├── README.md / README.en.md
├── CHANGELOG.md
├── LICENSE
├── scripts/
│   ├── record.mjs        # recording CLI (start/snap/actions/section/mark/mv/amend…)
│   ├── assemble.mjs      # run → hierarchical Markdown
│   ├── export.mjs        # run → docx/pdf/html/md
│   ├── preview.mjs       # interactive mind-map HTML / Mermaid / index
│   ├── registry.mjs      # sha256 recognition cache
│   ├── webbridge.mjs     # browser extension daemon client
│   ├── lib.mjs
│   └── selftest.mjs
├── templates/playbook.md
└── examples/bookshelf-demo/
```

## License

[MIT](LICENSE) © 2026 lhp609661060
