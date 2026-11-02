# dsh-session-delete

> 安装见 [INSTALL.md](INSTALL.md)，删除边界与安全校验见 [PRIVACY.md](PRIVACY.md)。

为 DeepSeek Harness（DSH）会话侧栏的「…」菜单增加**删除会话**操作：只删除当前工作区下的会话，先停止运行中的会话，再解绑工作区记账、删除会话日志目录、清理投影缓存，并立即刷新侧栏列表。

- **只删一个会话** —— 唯一的递归删除目标就是该会话自己的目录
- **五道安全校验** —— 与记忆路径双向重叠即拒绝
- **墓碑机制** —— 防止宿主内存里的活体会话把已删的行「复活」

**记忆插件的存储数据绝不会被触碰**：插件只对 `~/.dsh/sessions/<projectKey>/<encodedSessionId>` 这一个会话自己的目录做递归删除，从不递归删除工作区目录；每个删除目标在删除前都会与记忆路径集合做双向重叠检查，一旦发现重叠就直接拒绝。

## 安装

### 方式一：`dsh plugin`（Web / TUI profile）

```powershell
dsh plugin --profile <profile> add link:<本仓库克隆到的绝对路径>
```

> 桌面版（`desktop` profile）由 Electron 独占管理，`dsh plugin --profile desktop add` 会被拒绝，请用方式二或 GUI。

安装后重启 DSH（或由桌面版热加载）即可在会话行的「…」菜单看到「删除会话」。

### 方式二：GUI 插件管理器 / `plugin_manager` 工具

把插件的绝对路径作为安装 spec：

```
<本仓库克隆到的绝对路径>
```

插件包声明了 `dsh.bundle.patch` 与 `dsh.client.platform = "web"`，安装时会被加入 profile 的 bundle 列表。

> 本仓库不包含 `node_modules`。安装前请在插件目录执行 `pnpm install --ignore-scripts`（只依赖 `@deepseek-ai/schemastery` 及其两个小依赖，用于生成配置表单）。

## 使用

1. 在左侧会话列表中，把鼠标移到某个**属于工作区**的会话行上，点「…」。
2. 选择「删除会话」。
3. 确认对话框会显示：会话名、所属工作区、将被删除的日志目录、投影缓存与会话列表记账的清理说明，以及受保护的记忆路径数量。
4. 若会话**正在运行**，对话框会显示红色警告，确认按钮变为「停止并删除」：先停止当前工作（本轮对话会中断），再删除会话。
5. 删除成功后该行立即从当前工作区消失，无需手动刷新页面。

不属于任何工作区的「未分组」会话不会显示删除入口——本插件只处理工作区会话。因此，如果删除后的行显示在
“未分组”下，它已经不再受工作区记账管理，也就没有「删除会话」入口；这通常意味着它是一次**旧版本删除的残留**
（新版会保留归档标记把该行隐藏），完全重启 DSH 后就会消失。

## 记忆数据保护

默认保护以下路径（存在与否都会参与重叠检查）：

| 来源 | 路径 |
| --- | --- |
| 默认 | `$DSH_HOME/memory` |
| 默认 | `$DSH_HOME/.dsh-memory`（灵枢记忆） |
| 默认 | `$DSH_HOME/memories` |
| 环境变量 | `$DSH_MEMORY_DIR` |
| 记忆插件配置 | `memoryDir` / `dbFile`（从 profile 与插件包的 `cordis.patch.yml` 读取） |
| 工作区 | `<workspace>/对话记忆`、`<workspace>/记忆`、`<workspace>/.dsh-memory`、`<workspace>/memories` |
| 用户配置 | `memoryPathsToExclude` 的每一项 |

安全校验（`lib/paths.js` 的 `inspectDeletionTarget`）：

1. 目标目录名必须正好等于 `encodeSegment(sessionId)`；
2. 目标必须严格位于 `<DSH_HOME>/sessions` 之内（永远不是 sessions 根目录本身）；
3. 目标不能是符号链接/联接点（符号链接只 unlink，绝不 follow）；
4. 目标的 `realpath` 仍必须位于 sessions 根的真实路径内；
5. 目标与任一受保护路径不得相等、不得互相包含。

任何一项不满足都会拒绝删除并给出明确错误，不会静默跳过。

### 配置 `memoryPathsToExclude`

如果记忆插件把数据放在上述默认路径之外，可在 profile 的 `cordis.patch.yml` 里追加：

```yaml
- id: session-delete
  name: dsh-session-delete
  config:
    memoryPathsToExclude:
      - "D:\\memory-store"
      - "$DSH_HOME\\custom-memory"
      - "对话记忆/长期"
```

支持绝对路径、`~`、`$DSH_HOME` / `${DSH_HOME}` / `%DSH_HOME%` / `$HOME`，以及相对于所属工作区目录的路径。该选项同时出现在 DSH 的插件配置表单中（schemastery schema），也可以直接写进 profile 的 `cordis.patch.yml`。请不要把整个用户目录或 `$DSH_HOME` 设为排除项——那会让所有会话目录都被判定为“位于记忆路径内”而拒绝删除。

## 删除链路

```
停止运行中会话并归档（archiveSession + stopActivity，并等待 Agent 离开 running）
  → 写入活体缓冲事件（sessions.flush）
  → 删除该会话的日志目录（唯一递归删除目标，带 EBUSY/EPERM 退避重试）
  → 清理投影缓存（session_projcache*/sessions/<id>.json + 旧版总表项）
  → 验证性复查（删除后 300ms 再检查一次）
  → 文件清理完整时：解绑工作区记账（entity.detachSession），保留归档标记作为“墓碑”
  → 文件清理不完整时：取消归档并保留工作区记账，让该行仍可见、可重试
  → 复活守卫（约 2 分钟，指数退避；被迟到写入重建的目录会被再次删除）
  → 客户端 handleSessionRemoved + 不重新拉取列表（重新拉取会让宿主仍持有的活体会话重新出现）
```

## 已知限制：宿主内存中的活体会话

DSH 的 `session/list` 会合并 Host 进程内仍然存活的 Session（`ApiSessionList.list` 遍历
`sessionQuery.listSessions`，而后者会把 `ctx.sessions` 里的每个活体会话并进结果）。插件删除的是
磁盘上的会话文件，没有办法把一个活体会话从 Host 的内存会话表里移除，因此：

- 如果删除时该会话仍被 DSH 打开着，**取消归档 + 重新拉取列表**会让它立刻以“未分组”重新出现；
- 插件的做法是删除后**保留归档标记**：默认视图会隐藏归档行，所以即使宿主还持有活体会话，该行也不会再出现；
  下一次重启 DSH 后，归档集合里只剩一个无对应会话的 id，不会渲染任何行；
- 如果你在旧版本插件里已经遇到过“删除了还在”的行，**完全退出并重启 DSH** 即可清除（只刷新页面不够，
  因为宿主内存里仍然有它）。重启后磁盘上没有该会话，不会再回来。


## 异常处理

- **文件被占用（EBUSY / EPERM / EACCES / ENOTEMPTY）**：自动退避重试 4 次；仍失败时在对话框内显示具体路径、错误码与处理建议，不会静默失败。
- **Windows 活体删除竞态**：删除后做验证性复查；复活守卫在约 2 分钟内继续清理被重建的目录。
- **部分清理失败**：会话保留在工作区记账里并取消归档（可见、可重试，不会掉进“未分组且没有删除入口”的死角），对话框保留并显示失败清单，提供「重试清理」按钮。
- **不是工作区会话 / 跨工作区 / 工作区不存在**：Host 直接拒绝并返回可读错误。

## 技术说明

- Host 半（`lib/index.js`）是零运行时依赖的 Cordis 插件：注册 `sessionDelete` 服务，通过官方 Typert Remote SRC 通道暴露 `probe` / `delete`。
- Client 半（`lib/client.js`）是 `window.__ModuleLoader__.load` 格式的浏览器 bundle，只使用平台种子模块：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`。
- 菜单槽位：`sidebar.workspaces.session.menu.item`（order 500）。
- 对话框与 Toast：`shell.overlay`。
- 删除成功后走官方客户端方法 `sessions.handleSessionRemoved(id)`，只做本地移除，**不再**调用 `sessions.refresh()`——重新拉取会让宿主仍持有的活体会话以“未分组”复活；只有部分失败（会话仍存在、需要重新显示）时才刷新。

## 测试

```powershell
node test/verify.test.mjs
```

测试使用临时目录，不会访问真实 `~/.dsh`。覆盖：路径编码、记忆路径生成、双向重叠检测、单会话删除零误伤、投影缓存清理、活体会话墓碑（保留归档、不再取消归档）、失败停止后的兜底隐藏、记忆重叠拒绝、非工作区会话拒绝、配置校验。
