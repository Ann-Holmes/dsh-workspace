# 工作区约定

本工作区是一个用于探索 DeepSeek Harness（dsh）的临时工作区。

## 目录组织

- `docs/notes/`：个人/学习笔记放这里，不要堆在工作区根目录。
- `tmp/`（即 CWD/tmp）：临时调试产物与旧草稿——下载的包、解压目录、测试环境、调试脚本，以及用户旧草稿（如 `遗传密码表.*`）。**调试产物明确无用后清理**，不要长期留在根目录。
- `AGENTS.md`：本 rules 文件，随工作区自动被 `dsh-agent-instructions` 加载。
- 根目录保持干净：只放 meta 文件（`AGENTS.md`、`docs/`、`.gitignore` 等）；用户草稿与调试产物一律进 `tmp/`。

## 规则

- 写文件前先 `read` 现有内容，避免覆盖用户已有文件。
- 笔记类文档统一放 `docs/notes/`。
- 临时调试产物统一放 `tmp/`（CWD/tmp），明确无用后清理。
- 修改/删除文件前，若路径在工作区外（如 `~/.dsh`），会触发沙箱拒绝（EROFS），需升级权限并说明理由。

## Linting

**IMPORTANT: Lint every changed file before committing — this step is mandatory, not optional.**

Do NOT assume it will pass. Always run the linter and verify zero errors.

### Python Linting with Ruff

```shell
ruff format <path>
ruff check --fix <path>
```

### Markdown Linting with markdownlint-cli2

```shell
markdownlint-cli2 <path>
# Auto-fix if needed
markdownlint-cli2 --fix <path>
```

## Version Control

**Before committing**, run through this checklist:

1. **Lint**: `ruff format` + `ruff check --fix` for `.py`, `markdownlint-cli2` for `.md`
2. **Verify**: run tests or check the change does what it claims
3. **Commit**: use the format below

Follow the commit message format: `<emoji> <type>(<scope>): <description>\n\n<details>`

Types: ✨ feat, 🐞 fix, 🦄 refactor, 🌈 style, 🐎 ci, 📃 docs, 🐳 chore, 🎉 init

## 环境注意（排查 dsh 时）

- dsh 从源码 checkout 运行：
  - 用 `node apps/cli/lib/bin.js web ...`（构建版 CLI）——推荐，无 tsx 路径分裂。
  - 用 `pnpm dsh`（tsx 源码）——`@deepseek-ai/*` 内部包会因 tsconfig paths 解析到 src、外部插件（`~/.dsh/profiles`）解析到 lib，造成 typert-protocol 双实例、插件 RPC 404。
- 沙箱：`workspace-write` + 审批 `ask`；写工作区外需按需升 `danger-full-access`。
