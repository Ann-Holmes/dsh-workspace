# DSH bwrap 沙箱机制笔记

> 本文是我在排查 dsh-file 插件 404 过程中，对 DeepSeek Harness（DSH）文件沙箱（bwrap）的完整认识整理。
> 所有技术结论均直接来自本仓库源码与实测验证。

---

## 1. 一句话结论

**bwrap 是 DSH 的文件沙箱后端**（Linux 上用 bubblewrap 实现），本质是"用 Linux namespaces 快速搭起来的进程沙箱"，而不是 Docker 那种容器/虚拟系统。

它做了这样一件事：**只约束"写"、不隐藏"读"**——把宿主 `/` 只读挂进来、置顶一块可写的工作区 + `/tmp`，并隔离 PID 命名空间。它有意识地保留读权限（agent 必须读仓库、读系统库才能工作），拦的只是"别把工作区以外的东西写坏"。

---

## 2. 它是什么 / 不是什么

| 维度 | bwrap（DSH 用的） | Docker 容器 |
|---|---|---|
| 本质 | **纯 Linux namespaces** 设置（mount + PID），一条命令 `exec` 子进程 | OCI 容器运行时：镜像 + overlayfs 分层 + 全套隔离 |
| 守护进程 | 无 daemon、无镜像、无仓库，**毫秒级** | 需要 dockerd + 镜像 + 拉取/存储 |
| 文件系统 | **不复制根**，`--ro-bind / /` 直接挂宿主根只读，再叠可写层 | 独立镜像层（overlayfs），有自己复制的根 |
| 网络 | **无 `--unshare-net`** → 共享宿主网络 | 默认独立 netns（除非 `--network host`） |
| 进程可见性 | `--unshare-pid` → 沙箱内看不到外面进程 | 独立 PID + IPC + UTS 隔离 |
| 内核 | 与宿主共享（无 hypervisor） | 与宿主共享内核（无 hypervisor） |

**共同点**：都不是虚拟机（都共享宿主内核）。

---

## 3. 实际 bwrap 参数（源码）

DSH 的 bwrap 参数由 `packages/sandbox/sandbox-local/src/profiles.ts` 生成。

```js
// bwrapProfileArgs(policy)
const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--unshare-pid', '--proc', '/proc', '--die-with-parent']
if (policy.mode === 'workspace-write') {
  args.push('--tmpfs', '/tmp')
  args.push('--bind', policy.workspaceRoot, policy.workspaceRoot)
}
```

在 `workspace-write` 模式下，实际包裹每条 bash 命令的形态是：

```bash
bwrap --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent \
      --tmpfs /tmp \
      --bind <workspace> <workspace> \
      -- bash -c "<命令>"
```

逐项解释：

| 参数 | 作用 |
|---|---|
| `--ro-bind / /` | 把宿主根 `/` **只读**挂进来（读保留，写拒绝） |
| `--dev /dev` | 提供 `/dev`（设备） |
| `--unshare-pid` | 新建 PID 命名空间 → 沙箱内看不到外面进程 |
| `--proc /proc` | 挂 `/proc`（PID 命名空间的 `/proc`，故 `ps -ef` 为空） |
| `--die-with-parent` | 父进程死则沙箱一起退出 |
| `--tmpfs /tmp` | 把 `/tmp` 挂成可写的内存 tmpfs（仅 `workspace-write`） |
| `--bind <ws> <ws>` | 把工作区 bind 成**可写**（仅 `workspace-write`） |

**注意**：参数里**没有** `--unshare-net` → **网络命名空间不隔离**，沙箱内外网络互通。

---

## 4. 三种模式（文件效应策略）

DSH 沙箱的模式 `SandboxMode` 只治理**文件效应**，不治理网络与进程可见性：

| 模式 | 文件写权限 | 说明 |
|---|---|---|
| `read-only` | 拒绝写入（仅 `/dev/null` 等必需 sink） | 只读 |
| `workspace-write` | 允许写工作区 + `/tmp` | 默认模式，本会话用的 |
| `danger-full-access` | 绕过沙箱，直接跑原始 argv | 需要时按需升级 |

`danger-full-access` 是唯一不能发给沙箱提供者的模式——它**不调用** `ctx.sandbox`，直接用原始 argv 启动。

Linux 上 `sandbox-local` 会**优先选 bwrap**（> Landlock），因为它的挂载配置最接近完整边界，并被标记为 `full` enforcement：

```ts
linux: ['bwrap', 'landlock'],   // bwrap 优先
bwrap: 'full',                  // bwrap = 完整文件效应治理
```

Landlock 在某些旧内核 ABI 下是 `partial`。

---

## 5. 为什么保留宿主读权限——这是设计意图

**澄清一个认知误区**："隔离不够彻底所以保留读权限"——**不是**。

- Docker 的隔离是"**隐藏**文件系统"（给你独立 overlay 根，宿主的东西看不到）。
- DSH 沙箱的目的不同：它是**文件效应策略（file-effect policy）**，只管"**写**"。

DSH 故意保留整棵宿主 `/` 可读，因为 agent 必须读仓库、读 `node_modules`、读系统库才能运行 dsh。它要拦的只是"别把工作区以外写坏"。

> 一句话：**这是"能力保留、写聚焦"（capability-preserving, write-focused）的沙箱，而不是 Docker 那种"全套隔离"的容器。**

---

## 6. 沙箱与审批是两层独立机制

这是容易混淆的地方：**沙箱管"能写哪"，审批管"要不要先问人"**，两者是独立的两层。

from `packages/bundle/base/cordis.patch.yml`：

```yaml
# 第 1 层：沙箱（能写哪）
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()

# 第 2 层：审批（要不要先问）
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
  config:
    policy: !!js "(process.env.DSH_PERMISSION_MODE ?? 'workspace-write') === 'danger-full-access' ? 'never' : 'ask'"

# 组合预设：把两层绑成套餐
- id: permission
  name: '@deepseek-ai/dsh-permission-presets'
  config:
    presets:
      read-only:            { sandbox: read-only,            approval: ask }
      workspace-write:      { sandbox: workspace-write,      approval: ask }
      danger-full-access:   { sandbox: danger-full-access,   approval: never }
```

| 预设（preset） | 沙箱模式（写哪） | 审批（问人） |
|---|---|---|
| `read-only` | 只读 | ask |
| `workspace-write` | 工作区 + `/tmp` | ask |
| `danger-full-access` | 绕过沙箱 | **never** |

**本会话**：未设 `DSH_PERMISSION_MODE` → 默认 `workspace-write` → 沙箱 `workspace-write` + 审批 `ask`。

---

## 7. 实际体验：我遇到的三个限制

正因为这层设计，本次排查中完全一致：

| 能力 | 是否可用 | 原因 |
|---|---|---|
| **读**宿主文件（`~/.dsh`、源码） | ✅ | 根只读挂载，读不被拦 |
| **写**工作区外（`~/.dsh`） | ❌ EROFS | 只有工作区 + `/tmp` 可写 |
| **看/管理**外面进程（杀 5209） | ❌ | `--unshare-pid` → 看不到宿主进程 |
| **网络**（curl 5209、起测试服务器） | ✅ | 无 `--unshare-net`，网络共享 |

这就解释了为什么"重启 dsh 服务器"这类操作会卡住：**杀不了宿主进程、写不了工作区外的 profile**。

---

## 8. 按需绕过：`danger-full-access` + 审批

当确实需要写工作区外时，会触发一次"升级"：

1. 命令执行碰到沙箱拒绝（如对 `~/.dsh` 写入的 EROFS）。
2. 以更宽的 `sandbox_permissions`（`danger-full-access`）重试同一条命令，并附一句 `justification` 理由。
3. **审批层**（本会话 `approval: ask`）弹出确认，由用户批准后放行。
4. 批准后该命令以内核允许的完整访问执行（如刚才卸载 dsh-file 时写入 `~/.dsh/profiles/web`）。

> 注意：只有"真实拒绝"才能升级；且一次升级只对那一条命令生效。若当前审批策略已是 `never`（如 `danger-full-access` 预设），则不会询问。

---

## 9. 引入时间（git 历史）

| 日期 | 提交 | 内容 |
|---|---|---|
| 2026-06-10 | `b67e81ac97` | 仓库初始化 |
| **2026-07-09** | `7b8c3a9b40` | `feat(sandbox): the confinement seam and the per-platform native runner chains` —— **沙箱接缝 + bwrap/Landlock/Seatbelt/Windows-ACL 各平台运行器**（bwrap 后端在此落地） |
| **2026-07-14** | `2dc62497ce` | `feat(sandbox): cross-family file sandbox — one policy home, sandboxed fs provider, fs escalation parity` —— 引入统一策略解析 `sandbox-policy` |

**对当前会话而言**：它并非"本次才引入"，而是 `dsh-bash-sandbox` 默认给每条 bash 调用套上沙箱，模式取 `sandbox-policy` 的默认值 `workspace-write`。

---

## 10. 相关源码位置

| 文件 | 内容 |
|---|---|
| `packages/sandbox/sandbox/src/index.ts` | 沙箱接缝（`SandboxMode`、`SandboxPolicy`、`ctx.sandbox`） |
| `packages/sandbox/sandbox-local/src/index.ts` | 平台选择链：`linux: ['bwrap','landlock']`，`bwrap: 'full'` |
| `packages/sandbox/sandbox-local/src/profiles.ts` | **`bwrapProfileArgs()` 参数生成**（本文第 3 节的源码） |
| `packages/sandbox/sandbox-policy` | 策略解析（`ctx.sandboxPolicy`，mode + workspaceRoot 优先级） |
| `packages/shell/bash-sandbox` | bash 工具消费沙箱（`timeoutMs: 60000`） |
| `packages/bundle/base/cordis.patch.yml` | `sandbox` / `sandbox-policy` / `bash-sandbox` / `approval` / `permission`（本文第 6 节的配置） |
| `docs/subsystems/sandbox.md` | 子系统文档（"Network and process visibility are outside this vocabulary"） |

---

## 11. 一句话备忘

> **bwrap 是"写聚焦、读保留、网络共享"的轻量进程沙箱；沙箱管写哪、审批管问不问，两层分离，`danger-full-access` 是唯一需要按需升级的出口。**
