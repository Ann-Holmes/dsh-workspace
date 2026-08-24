# DSH bwrap 沙箱机制笔记

> 本文是我在排查 dsh-file 插件 404 过程中，对 DeepSeek Harness（DSH）文件沙箱（bwrap）的完整认识整理。
> 所有技术结论均直接来自本仓库源码与实测验证。
>
> **修订记录**：2026-08-24 修订——更正 `danger-full-access` 边界（它不是"任意权限/root"，而是"宿主机上以当前用户身份跑"，附实测 6→1562 进程证据）；把审批/权限部分展开为 6.1/6.2、8.1/8.2/8.3，并澄清"danger-full-access"的**两个含义**（整会话预设 vs 单条命令升级）。

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
| `danger-full-access` | **不套 bwrap**，直接以当前 OS 用户身份在宿主机跑原始 argv | 见第 6 节的"两层含义" |

`danger-full-access` 是唯一不能发给沙箱提供者的模式——它**不调用** `ctx.sandbox`，直接用原始 argv 启动。这里有一个**必须先澄清的边界**（本笔记最初写简单了，下面是更正后的准确版本）：

> **`danger-full-access` 不是"任意权限/root"，而是"宿主机上、以当前 OS 用户（本机为 `hzl`）的身份直接跑"。**

它去掉了 bwrap 这一层，所以：

- ✅ **完整进程可见性**：不再受 `--unshare-pid` 限制，能看到并管理宿主的真实进程表（含能杀掉 dsh 服务器进程）。
- ✅ **读写任何该用户有权限的东西**：`~/.dsh`、profile 等都能写。
- ❌ **不能做 root 才能做的事**：改系统级文件、杀 root 进程等仍被 OS 权限挡住。

**实测证据**（本次会话）：同一台机器上，常规 `workspace-write` 模式 `ps -ef` 只返回沙箱进程树的 **6** 个进程；升级到 `danger-full-access` 后返回宿主全量 **1562** 个进程，其中就包含了用户那个 tsx 版 dsh 服务器（`node --import tsx/esm apps/cli/src/bin.ts web ... --port 5209`）。

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
# 第 1 层：沙箱（能写哪）——内核层能力护栏
- id: sandbox-policy
  name: '@deepseek-ai/dsh-sandbox-policy'
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'
    workspaceRoot: !!js process.cwd()

# 第 2 层：审批（要不要先问）——决策门
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

### 6.1 关键词 `danger-full-access` 有**两个不同含义**（必须区分）

同一个词，在不同语境指两件不同的事：

| 含义 | 作用范围 | 行为 |
|---|---|---|
| **A. 会话预设** `permission: danger-full-access` | 整场会话 | 每条命令都不套 bwrap + 审批 `never`（**全程不弹确认**） |
| **B. 单条命令升级** `sandbox_permissions: danger-full-access` | 仅当前这一条命令 | 这条命令不套 bwrap，但**审批仍是 `ask`** → 仍会弹一次确认（一次性的） |

两者**不在一个层面**：A 是"整场会话的模式设定"，B 是"单次工具调用越过当前模式"。

### 6.2 审批层的"放行"逻辑

审批层的值只有两个语义（由 `dsh-user-approval` 的 `policy` 决定）：

- `ask`：遇到需要"更宽权限"的操作时，弹出确认，由**人**决定是否放行。
- `never`：不询问，直接放行（通常只在 `danger-full-access` 预设下用到）。

关键点：**审批不是按"大小"自动判断，而是把决定权交给人类**。沙箱拦下的是一个事实（EROFS / 不完整可见），审批层负责把"要不要越界"这个问题抛给人。审批 `ask` 不代表"会拒绝"，而是"要问"；`never` 也不代表"更安全"，而是"不问"——它常常和 `danger-full-access` 绑定，意味着"已经全放开，没必要再问"。

---

## 7. 实际体验（本次会话实测）

正因为这层设计，本次排查中完全一致：

| 能力 | 是否可用 | 原因 |
|---|---|---|
| **读**宿主文件（`~/.dsh`、源码） | ✅ | 根只读挂载，读不被拦 |
| **写**工作区外（`~/.dsh`） | ❌ EROFS | 只有工作区 + `/tmp` 可写 |
| **看/管理**外面进程（杀 5209） | ❌ | `--unshare-pid` → 看不到宿主进程 |
| **网络**（curl 5209、起测试服务器） | ✅ | 无 `--unshare-net`，网络共享 |
| 升级到 `danger-full-access` 后看进程 | ✅ | 不套 bwrap → 直接见宿主进程表（6 → 1562） |

注意最后一行：**常规模式看不到宿主进程，但升级到 `danger-full-access` 就能看到**——这正是第 4 节那个"宿主机用户身份"边界的实证。这解释了为什么"重启 dsh 服务器"这类操作会卡住：常规模式**杀不了宿主进程、写不了工作区外的 profile**，只有升级后才具备这些能力。

---

## 8. 按需绕过：单条命令升级到 `danger-full-access` + 审批

当确实需要越过当前模式（写工作区外 / 看宿主进程）时，会触发一次"**升级（escalation）**"。这是"单条命令升级"（第 6.1 节的含义 B），走的是一条受限的、需要人确认的路径。

### 8.1 流程（本会话 `workspace-write` + `ask`）

1. **命令被沙箱拒绝**。这通常表现为文件写被拒（对 `~/.dsh` 写入报 `EROFS`），或能力被 `--unshare-pid` 截断（看不到宿主进程）。
2. **只读命令被截断的情况**：`ps -ef` 在常规模式不报错，只返回沙箱进程树（6 个）——它不是"文件效应拒绝"，但同样受沙箱限制。
3. **以更宽的 `sandbox_permissions` 重试同一条命令**，并附一句 `justification`（为什么需要更宽）。
4. **审批层（`approval: ask`）弹出确认**——即使我们是在"单条命令升级"，审批仍是 `ask`（不是 `never`），所以这一步**一定会问人**。
5. **用户批准后放行**：该命令这一次不再套 bwrap，以当前 OS 用户身份直接在宿主机执行（如写入 `~/.dsh/profiles/web` 已完成 dsh-file 卸载、或能看到 1562 个宿主进程）。

### 8.2 关键守则（这些限制让"升级"不会变成随便越权）

- **一次只对一条命令生效**：`sandbox_permissions` 是工具调用级别的参数，只放宽当前这一次调用，不改变整个会话的模式。
- **用"刚好够用的更宽档位"**：从 `workspace-write` 出发，下一个更宽的就是 `danger-full-access`（`read-only` 是更窄，不是方向）。DSH 没有更细粒度的档位，所以这一步是"要么工作区，要么全放开"。
- **升级要有真实理由**（`justification`）：不是随手加宽，而是明确说明这次调用为什么需要。
- **拒绝是最终的不例外**：如果会话设定了**审批提示被禁用**，那么被拒就是最终结果——**此时绝不能设置 `sandbox_permissions`**，也不能用别的方式绕过它。
- **不臆测升级**：升级通常"锚定在一次真实拒绝上"（即这条命令刚碰到的拒绝）；只有在"本会话已经拒绝过同样的访问"时才允许预先升级。

### 8.3 与"整会话 `danger-full-access`"的区别

| | 单条命令升级（本节） | 整会话预设 `danger-full-access` |
|---|---|---|
| 作用范围 | 仅一条命令 | 整场会话 |
| 沙箱 | 这条命令不套 bwrap | 每条命令都不套 bwrap |
| 审批 | **仍 `ask`**（本会话下会问） | **`never`**（不问） |

所以：**升级 ≠ 悄无声息地放开**。在当前 `workspace-write`/`ask` 会话下，哪怕我升级到 `danger-full-access`，这条命令的批准权仍在你这儿。

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
| `packages/interaction/user-approval` | **审批层** `dsh-user-approval`（`ask`/`never`） |
| `packages/interaction/permission-presets` | **预设** `dsh-permission-presets`（三档组合） |
| `packages/bundle/base/cordis.patch.yml` | `sandbox` / `sandbox-policy` / `bash-sandbox` / `approval` / `permission`（本文第 6 节的配置） |
| `docs/subsystems/sandbox.md` | 子系统文档（"Network and process visibility are outside this vocabulary"） |

---

## 11. 一句话备忘

> **bwrap 是"写聚焦、读保留、网络共享"的轻量进程沙箱；沙箱管写哪、审批管问不问，两层分离。`danger-full-access` 有两层含义：整会话预设（绕过沙箱 + 审批 `never`），或单条命令升级（这条命令绕过沙箱，但审批仍 `ask`）。升级不是"任意权限"，而是"宿主机上以当前用户身份跑"——能看到/管理用户自己的进程、能写用户有权限的地方，但**不是 root**。**
