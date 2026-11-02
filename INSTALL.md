# 安装

## 给人看

### 前置

| 项 | 要求 |
|---|---|
| DSH | 0.2.1-rc.3 或更新 |
| Node | ≥ 18 |
| 依赖 | `@deepseek-ai/schemastery`（仓库不含 `node_modules`，安装前先 `pnpm install --ignore-scripts`） |

### 三选一

**A. GUI（桌面版推荐）**

设置 → 插件 → 安装 → 选本仓库目录 → 重启 DSH。

**B. `dsh plugin`（Web / TUI profile）**

```sh
dsh plugin --profile <profile> add link:<本仓库绝对路径>
```

> 桌面版的 `desktop` profile 由 Electron 独占管理，这条命令会被拒绝，请用 A 或 C。

**C. 手工**

`~/.dsh/profiles/<profile>/package.json` 两处：

```jsonc
{
  "dependencies": { "dsh-session-delete": "link:<本仓库绝对路径，反斜杠改正斜杠>" },
  "dsh": { "profile": { "bundles": ["...其他", "dsh-session-delete"] } }
}
```

然后 `pnpm install --no-frozen-lockfile`，重启。

### 首次启动

会话行的「…」菜单多出「删除会话」。只对**属于工作区**的会话显示。

### 卸载

```sh
dsh plugin --profile <profile> remove dsh-session-delete
```

---

## 给 agent 执行

你负责配置，**不能重启 DSH**。

### 1. 探测

```powershell
$dshHome = Join-Path $env:USERPROFILE '.dsh'
$profile = 'desktop'
$profDir = Join-Path $dshHome "profiles\$profile"
$plugDir = Join-Path $dshHome 'plugins\dsh-session-delete'

"DSH_HOME      : $(Test-Path $dshHome)"
"profile dir   : $(Test-Path $profDir)"
"already there : $(Test-Path $plugDir)"
```

`profile dir = False` 时去 `~/.dsh/profiles/` 看实际名字。

### 2. 写权限

```powershell
try { New-Item -ItemType Directory -Force -Path (Join-Path $dshHome 'plugins') | Out-Null; "WRITABLE" }
catch { "BLOCKED: $($_.Exception.Message)" }
```

### 3. 路径 A

```powershell
Copy-Item -Recurse -Force '<本仓库绝对路径>' $plugDir
Push-Location $plugDir
node --version   # 确认可用；不可用则用 $dshHome\dsh-runtimes\*\dependencies\node\bin\node.exe
Pop-Location
```

装依赖（仓库不含 `node_modules`）：

```powershell
$pnpm = (Get-ChildItem "$dshHome\dsh-runtimes\*\dependencies\pnpm\bin\pnpm.mjs" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
$node = (Get-ChildItem "$dshHome\dsh-runtimes\*\dependencies\node\bin\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1).FullName
Push-Location $plugDir; node $pnpm install --ignore-scripts; Pop-Location
Test-Path (Join-Path $plugDir 'node_modules\@deepseek-ai\schemastery')
```

改 profile 的 `package.json` 两处（`dependencies` + `dsh.profile.bundles`），方法见 [dsh-memory-rules 的 INSTALL.md](https://github.com/147-sys/dsh-memory-rules/blob/main/INSTALL.md) 里的 `patch-profile.mjs`。

改完在 profile 目录跑 `pnpm install --no-frozen-lockfile`，确认：

```powershell
Test-Path (Join-Path $profDir 'node_modules\dsh-session-delete')
```

然后告诉人重启。

### 4. 路径 B：无权限

不要把删除权限当成安装权限来绕过。把两处配置和命令交给人。

### 5. 失败分支

| 现象 | 处理 |
|---|---|
| `ERR_PNPM_NO_IMPORTER_MANIFEST_FOUND` | 没在目标目录执行 |
| 菜单里没有「删除会话」 | `bundles` 没写，或没重启 |
| `Cannot find package '@deepseek-ai/schemastery'` | 插件的 `pnpm install` 没跑 |

### 6. 回滚

从 package.json 删两处 → 删 `~/.dsh/plugins/dsh-session-delete` → 重启。
