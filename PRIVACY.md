# 隐私与安全声明

**一句话**：本插件只删 DSH 自己的会话文件，不联网、不收集数据；删除前会与记忆路径做双向重叠检查，命中即拒绝。

## 插件自己存数据吗

**不存。** 没有数据库、没有日志文件、没有配置文件写入。唯一的写操作是删除。

## 会删什么

| 目标 | 说明 |
|---|---|
| `<DSH_HOME>/sessions/<projectKey>/<encodedSessionId>` | 该会话自己的日志目录，**唯一**的递归删除目标 |
| 投影缓存 | `session_projcache*/sessions/<id>.json` 及旧版总表条目 |
| 会话列表记账 | 文件清理完整后解绑（`entity.detachSession`） |

## 不会删什么

- 工作区目录本身（从不递归删除工作区）；
- `$DSH_HOME/memory`、`$DSH_HOME/.dsh-memory`、`$DSH_HOME/memories`、`$DSH_MEMORY_DIR`；
- 记忆插件配置的 `memoryDir` / `dbFile`；
- `<workspace>/对话记忆`、`<workspace>/记忆`、`<workspace>/.dsh-memory`、`<workspace>/memories`；
- `memoryPathsToExclude` 里列出的任何路径。

## 删除前的五道校验

`lib/paths.js` 的 `inspectDeletionTarget`：

1. 目录名必须正好等于 `encodeSegment(sessionId)`；
2. 必须严格位于 `<DSH_HOME>/sessions` 之内，且不是 sessions 根目录；
3. 不能是符号链接/联接点（符号链接只 unlink，不 follow）；
4. `realpath` 仍必须落在 sessions 根的真实路径内；
5. 与任一受保护路径不得相等、不得互相包含。

任一不满足都会抛错并拒绝，不会静默跳过。

## 会不会离开本机

**不会。** 全部逻辑在 Host 进程内完成，无网络请求。

## 已知风险

1. **删除不可逆**：没有回收站，删了就没了。会话内容不会被备份。
2. **运行中的会话**：确认后会先停止正在进行的一轮对话，该轮输出会丢失。
3. **墓碑机制**：删除后保留归档标记，用来阻止宿主内存里的活体会话把行“复活”；重启后该标记失效，不再显示。
4. **部分失败**：文件清理不完整时会取消归档、保留工作区记账，行仍可见并可重试——这是有意设计，**但意味着一次删除可能只完成一部分**，请以对话框的失败清单为准。
5. **路径配置权**：`memoryPathsToExclude` 配错（例如把整个 home 设进去）会让删除被大面积拒绝，属保护性失败。

## 漏洞与安全问题

发现安全问题请开 issue。涉及误删的，请附上对话框里的目标路径与错误码，不要贴会话正文。
