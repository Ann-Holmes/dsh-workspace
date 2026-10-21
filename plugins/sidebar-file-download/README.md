# 侧栏文件下载（@local/dsh-sidebar-file-download）

给 Web 端右侧栏（Sidebar）的文件预览加一个「下载」控件：文件从浏览器下载到本机。

## 它做了什么

- **预览标题栏按钮** —— 注册进 `sidebar.right.tab.document.actions`，在路径右侧、`Open in app` 之后多一个 28px 圆形下载按钮，与相邻宿主控件同尺寸、同主题 token。
- **无法预览时的按钮** —— 注册进 `sidebar.right.tab.document.unpreviewable`，`.zip`、字体等没有渲染器的文件也能在空状态直接下载。
- **读取方式** —— 调用已授权的 `workspaceFiles` Remote：先 `stat` 拿大小，能整文件读就一次读完（Host 默认上限 32 MiB），超过上限就按 2 MiB 窗口循环读取拼成 Blob，再交给浏览器下载管理器。

失败（文件被删、不是普通文件、超出读取上限、超过 512 MB 的浏览器内存上限）会以右下角提示条显示本地化原因，6 秒后自动消失。

## 安装

```sh
dsh plugin --profile web add /home/hzl/Work/Tmp/dsh-workspace/plugins/sidebar-file-download
```

或在本会话里用 `plugin_manager` 的 `install_bundle` 指向该目录。**profile 用 link 指向这个目录**：删掉或移动目录会让菜单里的插件失效；移动后要 `remove_bundle` → 从新路径 `install_bundle`，并**重启 `dsh web`**（`dsh-client-modules` 会把包的 `client.js` 路径缓存到进程重启为止）。

## 结构

| 文件 | 作用 |
|---|---|
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（`platform: web`，`inject` 等待 `ui-sidebar-documentpreview` 先激活） |
| `cordis.patch.yml` | 插入一行 Host 插件条目 |
| `index.js` | Host 半：空的 `apply()`，能力全在浏览器侧 |
| `client.js` | 浏览器半：两个 slot 注册、读取/合并字节、Blob 下载、提示条 |
| `locale/en.json`、`locale/zh.json` | 插件管理页显示的标题与描述 |
| `icon.svg` | 插件图标（下载箭头，原创） |

## 已知限制

- 文件树的行本身没有行级 slot，所以下载入口在「打开后的预览」里，而不是直接挂在树上。
- 字节先经过页面内存：> 512 MB 的文件会被拒绝并给出提示（宿主 Remote 没有流式接口）。
- 只对当前会话可读的文件生效；读取权限仍由 Host 的 `workspaceFiles` 与文件系统策略决定。
