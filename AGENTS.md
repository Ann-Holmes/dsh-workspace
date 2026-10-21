# 工作区约定

本工作区是一个用于探索 DeepSeek Harness（dsh）的临时工作区。

## 目录组织

- `docs/notes/`：个人/学习笔记放这里，不要堆在工作区根目录。
- `plugins/<name>/`：自研 dsh 插件（bundle）源码，一个插件一个子目录，见下方「插件」。
- `tmp/`（即 CWD/tmp）：临时调试产物与旧草稿——下载的包、解压目录、测试环境、调试脚本，以及用户旧草稿（如 `遗传密码表.*`）。**调试产物明确无用后清理**，不要长期留在根目录；**插件源码不要放这里**。
- `AGENTS.md`：本 rules 文件，随工作区自动被 `dsh-agent-instructions` 加载。
- 根目录保持干净：只放 meta 文件与长期内容（`AGENTS.md`、`docs/`、`plugins/`、`.gitignore` 等）；用户草稿与调试产物一律进 `tmp/`。

## 规则

- 写文件前先 `read` 现有内容，避免覆盖用户已有文件。
- 笔记类文档统一放 `docs/notes/`。
- 临时调试产物统一放 `tmp/`（CWD/tmp），明确无用后清理。
- 插件源码统一放 `plugins/<name>/`，安装/卸载只走 `plugin_manager`（`install_bundle` / `remove_bundle`），不要手写 `~/.dsh/profiles/<profile>/package.json` 或 `cordis.patch.yml`。
- 修改/删除文件前，若路径在工作区外（如 `~/.dsh`），会触发沙箱拒绝（EROFS），需升级权限并说明理由。

## 插件（plugins/）

每个插件是一个标准 bundle 目录：`package.json`（`dsh.bundle.patch` + 可选的 `dsh.client`）、`cordis.patch.yml`、`index.js`（Host 半）、`client.js`（浏览器半，可省略）、`locale/*.json`（插件管理页的标题/描述）、`icon.svg`，外加一份 `README.md` 说明用途。

安装与生效：

- 安装：`plugin_manager` 的 `install_bundle`，`target` 用插件目录的**绝对路径**；profile 里记成 `link:<该目录>`，所以目录被移动、改名或删除都会让插件失效。
- 移动/改名插件目录：先 `remove_bundle`，再从新路径 `install_bundle`。
- 改 `client.js`：HMR 会换掉页面里的模块；改 `index.js`（Host 半）或移动了安装路径：**重启 `dsh web`** 才干净。`dsh-client-modules` 按 Loader specifier 缓存包的 `client.js` 路径直到进程重启，所以同一包名换了源目录后，仅刷新页面不足以让浏览器半重新挂上。
- 卸载：`remove_bundle`（同时清掉 profile 里的 link 依赖）。
- 当前插件：`plugins/sidebar-file-download` —— 右侧栏文件预览标题栏的下载按钮。

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

### 网络与代理（推 GitHub 时）

- **远程仓库已改为 SSH**：`origin` = `git@github.com:Ann-Holmes/dsh-workspace.git`，`main` 跟踪 `origin/main`。日常 `git push` / `git fetch` 走 SSH 直连（`~/.ssh/id_rsa`，已验证可登录 `Ann-Holmes`），**既不需要代理也不需要 token**；不要再把 remote 改回 HTTPS。
- **直连 `github.com` 的 HTTPS 不通**：`curl https://github.com/...` 返回 `000`，`git ls-remote` 报 `HTTP/2 stream 1 was not closed cleanly`（HTTP/1.1 下直接超时）。其它外网（`example.com`、`api.github.com`）正常，所以别误判成“没网”。SSH 不受此影响。
- **HTTPS 推送不要指望现成凭据**：`gh` 里 `github.com` 的 token 已失效，`credential.helper=cache` 没有缓存，也没有 `~/.git-credentials`；不要去找/打印 token，也不要把 remote 切回 HTTPS 来“试试”。`git push` 会停在 `could not read Username for 'https://github.com'`。
- **确实需要 HTTPS 访问时走本地 Clash 代理**：`proxy_on` / `proxy_off` 来自 `/etc/profile.d/clash.sh`（`~/.zshrc` 里 source），本质是设置 `http_proxy` / `https_proxy` = `http://127.0.0.1:7890`。agent 的 bash 是 `bash -c`，拿不到 zsh 函数，直接内联同样几个变量：

  ```shell
  export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890 \
         HTTP_PROXY=http://127.0.0.1:7890 HTTPS_PROXY=http://127.0.0.1:7890 \
         no_proxy=127.0.0.1,localhost NO_PROXY=127.0.0.1,localhost
  curl -x http://127.0.0.1:7890 -o /dev/null -w '%{http_code}\n' https://github.com/Ann-Holmes/dsh-workspace
  ```

  返回 `200` 说明代理与 github HTTPS 都可用（直连时是 `000`）。适配场景：临时改成 HTTPS remote、访问 GitHub API、下载 release 包等。

- **推送流程**（SSH，默认无需任何环境变量）：

  ```shell
  git push            # origin 已是 SSH
  git status -sb      # 期望 `## main...origin/main`，没有 ahead/behind
  ```

  如果某次误走 HTTPS 推送导致 `origin/main` 没更新，用 `git fetch origin`（SSH）刷新跟踪分支即可，不必动代理。
