/**
 * dsh-session-delete — browser half.
 *
 * Adds one "删除会话" row to a workspace Session's "…" menu. The row opens a
 * real confirmation dialog in `shell.overlay` (the menu itself unmounts), shows
 * what will be deleted, warns when the session is still running, and reports
 * every partial-cleanup failure instead of hiding it.
 *
 * The dialog lives outside the menu because the row unmounts with the menu; it
 * talks to the Host through the mounted Typert Remote namespace, removes the
 * row locally after a complete deletion, and does not re-fetch the list — a
 * Host that still holds the Session live would list it again under Ungrouped.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const { useState, useEffect } = React;
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;

		const PACKAGE = "dsh-session-delete";
		const MENU_SLOT = "sidebar.workspaces.session.menu.item";
		const MENU_ORDER = 500;

		// ── request/toast buses ─────────────────────────────────────────────
		// apply() runs outside React, so no hook may be called there. The menu
		// row only publishes; the overlay components own all React state.
		const dialogBus = { listener: null, seq: 0 };
		const toastBus = { listener: null, seq: 0 };

		function requestDelete(request) {
			dialogBus.seq += 1;
			const item = { ...request, seq: dialogBus.seq };
			const listener = dialogBus.listener;
			if (typeof listener !== "function") {
				console.warn(`[${PACKAGE}] delete dialog is not mounted`);
				return;
			}
			listener(item);
		}

		function showToast(text, tone) {
			toastBus.seq += 1;
			const item = { text, tone, seq: toastBus.seq };
			const listener = toastBus.listener;
			if (typeof listener !== "function") {
				console.warn(`[${PACKAGE}] toast listener is not mounted: ${text}`);
				return;
			}
			try {
				listener(item);
			} catch (error) {
				console.warn(`[${PACKAGE}] toast dispatch failed`, error);
			}
		}

		// ── styles (theme tokens; no CSS module needed) ─────────────────────
		const styles = {
			body: { display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: 1.55 },
			row: { display: "flex", gap: 8, alignItems: "baseline" },
			label: { flex: "0 0 auto", color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
			value: { minWidth: 0, wordBreak: "break-all", color: "var(--dsw-alias-label-primary)" },
			path: {
				fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace",
				fontSize: 12,
				background: "var(--dsw-alias-bg-layer-2)",
				borderRadius: 4,
				padding: "3px 6px",
				wordBreak: "break-all"
			},
			sectionTitle: { fontSize: 12, fontWeight: 600, color: "var(--dsw-alias-label-secondary)", marginBottom: 4 },
			list: { margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 4 },
			warn: {
				border: "1px solid var(--dsw-alias-state-warn-primary)",
				borderRadius: 6,
				padding: "8px 10px",
				color: "var(--dsw-alias-state-warn-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent)"
			},
			error: {
				border: "1px solid var(--dsw-alias-state-error-primary)",
				borderRadius: 6,
				padding: "8px 10px",
				color: "var(--dsw-alias-state-error-primary)",
				background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent)"
			},
			ok: {
				border: "1px solid var(--dsw-alias-border-l1)",
				borderRadius: 6,
				padding: "8px 10px",
				color: "var(--dsw-alias-label-secondary)",
				background: "var(--dsw-alias-bg-layer-1)"
			},
			hint: { color: "var(--dsw-alias-label-secondary)", fontSize: 12 },
			mono: { fontFamily: "ui-monospace, SFMono-Regular, Consolas, 'Liberation Mono', monospace", fontSize: 11 }
		};

		// ── small presentational helpers ────────────────────────────────────
		function Row({ label, children }) {
			return jsxs("div", {
				style: styles.row,
				children: [jsx("span", { style: styles.label, children: label }), jsx("span", { style: styles.value, children })]
			});
		}

		function PathList({ paths }) {
			if (!Array.isArray(paths) || paths.length === 0) {
				return jsx("div", { style: styles.hint, children: "未发现匹配的路径。" });
			}
			return jsx("ul", {
				style: styles.list,
				children: paths.map((path) => jsx("li", { children: jsx("code", { style: styles.path, children: path }) }, path))
			});
		}

		function Toaster() {
			const [toast, setToast] = useState(null);
			useEffect(() => {
				toastBus.listener = setToast;
				return () => {
					if (toastBus.listener === setToast) toastBus.listener = null;
				};
			}, []);
			if (toast === null) return null;
			return jsx(primitives.Toast, {
				text: toast.text,
				tone: toast.tone,
				holdMs: 6000,
				onDone: () => {
					setToast((current) => (current !== null && current.seq === toast.seq ? null : current));
				}
			});
		}

		// ── the "…" menu row ────────────────────────────────────────────────
		function DeleteSessionMenuItem(props) {
			const { sessionId, displayTitle, useWorkspaces, useMenuOpenState, requestDelete: request } = props;
			const [, setMenuOpen] = useMenuOpenState();
			const workspace = typeof useWorkspaces === "function"
				? useWorkspaces((state) => {
					const items = state?.items;
					if (!Array.isArray(items)) return null;
					return items.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId)) ?? null;
				})
				: null;

			// Only workspace-accounted sessions are in scope. This is the same
			// rule the Host enforces; hiding the row for ungrouped rows avoids a
			// dead-end confirmation dialog.
			if (workspace === null || workspace === undefined) return null;

			return jsx(primitives.MenuItemButton, {
				icon: jsx(primitives.IconTrashOutlineRegular, {}),
				danger: true,
				onSelect: () => {
					setMenuOpen(false);
					request({
						sessionId,
						displayTitle: typeof displayTitle === "string" ? displayTitle : "",
						workspace: {
							workspaceId: workspace.workspaceId,
							title: workspace.title,
							path: workspace.path
						}
					});
				},
				children: "删除会话"
			});
		}

		// ── confirmation dialog (shell.overlay) ─────────────────────────────
		function DeleteSessionDialog({ request, call, dropSession, refreshList, onClose }) {
			const [phase, setPhase] = useState("probing");
			const [probe, setProbe] = useState(null);
			const [error, setError] = useState(null);
			const [result, setResult] = useState(null);
			const [retried, setRetried] = useState(false);
			const [attempt, setAttempt] = useState(0);

			const sessionId = request.sessionId;
			const workspaceId = request.workspace?.workspaceId;
			const displayTitle = request.displayTitle !== undefined && request.displayTitle !== "" ? request.displayTitle : "（未命名会话）";
			const workspaceTitle = probe?.workspace?.title ?? request.workspace?.title ?? "";
			const workspacePath = probe?.workspace?.path ?? request.workspace?.path ?? "";
			const running = probe?.running === true;

			useEffect(() => {
				let cancelled = false;
				setPhase("probing");
				setError(null);
				setProbe(null);
				setResult(null);
				Promise.resolve(call("probe", { sessionId, workspaceId, retry: retried })).then((reply) => {
					if (cancelled) return;
					if (!reply.ok) {
						setError(reply.error);
						setPhase("probe-error");
						return;
					}
					setProbe(reply.value);
					setPhase("ready");
				});
				return () => {
					cancelled = true;
				};
			}, [attempt]);

			const runDelete = () => {
				setPhase("deleting");
				setError(null);
				Promise.resolve(call("delete", { sessionId, workspaceId, retry: retried })).then((reply) => {
					if (!reply.ok) {
						setError(reply.error);
						setRetried(true);
						setPhase("delete-error");
						return;
					}
					const value = reply.value ?? {};
					setResult(value);
					const removed = value.removed ?? {};
					const filesGone = (removed.failedDirs ?? []).length === 0
						&& (removed.failedCache ?? []).length === 0
						&& (removed.survivors ?? []).length === 0;
					if (filesGone) {
						// Remove the row locally and deliberately do NOT refresh: the
						// Host still lists a Session it holds live, so a refresh would
						// re-add the just-deleted row under Ungrouped. The Host kept the
						// archive flag as a tombstone, so the row also stays hidden on
						// later refreshes.
						if (typeof dropSession === "function") dropSession(sessionId);
					} else if (typeof refreshList === "function") {
						// Partial cleanup leaves the Session in place (and unarchived on
						// the Host) so the retry entry stays in its workspace.
						refreshList();
					}
					if (value.complete === true) {
						showToast(`已删除会话「${displayTitle}」`, "success");
						onClose();
						return;
					}
					setRetried(true);
					setPhase("partial");
					showToast("会话已移出工作区，但部分文件清理失败", "warning");
				});
			};

			const retryProbe = () => {
				setRetried(true);
				setAttempt((value) => value + 1);
			};

			const close = () => {
				if (phase === "deleting") return;
				onClose();
			};

			const confirm = () => {
				if (phase === "deleting" || phase === "probing") return;
				runDelete();
			};

			const busy = phase === "deleting";
			const canConfirm = phase === "ready" && (probe?.dirs ?? []).every((entry) => entry.safe !== false);

			const footer = jsxs(React.Fragment, {
				children: [
					jsx(primitives.Button, {
						variant: "outline",
						disabled: busy,
						onClick: close,
						children: "取消"
					}),
					phase === "partial" || phase === "delete-error"
						? jsx(primitives.Button, {
							variant: "primary",
							disabled: busy,
							onClick: runDelete,
							children: busy ? "正在重试…" : "重试清理"
						})
						: phase === "probe-error"
							? jsx(primitives.Button, {
								variant: "primary",
								disabled: busy,
								onClick: retryProbe,
								children: "重新检查"
							})
							: jsx(primitives.Button, {
								variant: "primary",
								disabled: !canConfirm || busy,
								onClick: confirm,
								children: busy ? "正在删除…" : running ? "停止并删除" : "删除会话"
							})
				]
			});

			const body = [];

			if (phase === "probing") {
				body.push(jsx("div", { style: styles.hint, children: "正在检查会话状态、日志目录与受保护的记忆路径…" }, "probing"));
			}

			if (phase === "probe-error") {
				body.push(jsx("div", {
					style: styles.error,
					role: "alert",
					children: `无法检查该会话：${error ?? "未知错误"}`
				}, "probe-error"));
			}

			if (phase === "delete-error") {
				body.push(jsx("div", {
					style: styles.error,
					role: "alert",
					children: `删除失败：${error ?? "未知错误"}`
				}, "delete-error"));
			}

			if (probe !== null && phase !== "probe-error") {
				body.push(jsxs("div", {
					style: styles.body,
					children: [
						jsx(Row, { label: "会话", children: displayTitle }),
						jsx(Row, { label: "工作区", children: workspaceTitle }),
						workspacePath !== "" ? jsx(Row, { label: "工作区目录", children: jsx("code", { style: styles.path, children: workspacePath }) }) : null
					]
				}, "summary"));

				if (running) {
					body.push(jsxs("div", {
						style: styles.warn,
						role: "alert",
						children: [
							jsx("strong", { children: "该会话正在运行。" }),
							jsx("div", { children: "点击「停止并删除」会先停止当前工作（本轮对话会被中断），然后删除会话。若只想保留本轮结果，请先取消并等待本轮结束。" })
						]
					}, "running"));
				} else if (probe.live === true) {
					body.push(jsx("div", {
						style: styles.warn,
						children: "该会话当前已在界面中打开。Windows 上文件句柄可能仍被占用，删除失败时会给出明确提示。"
					}, "live"));
				}

				body.push(jsxs("div", {
					children: [
						jsx("div", { style: styles.sectionTitle, children: "将删除的会话日志目录" }),
						jsx(PathList, { paths: (probe.dirs ?? []).filter((entry) => entry.safe !== false).map((entry) => entry.path) }),
						(probe.dirs ?? []).some((entry) => entry.safe === false)
							? jsx("div", {
								style: styles.error,
								role: "alert",
								children: "检测到与受保护路径冲突的目标，已拒绝删除。请检查插件配置 memoryPathsToExclude。"
							})
							: null
					]
				}, "dirs"));

				body.push(jsxs("div", {
					children: [
						jsx("div", { style: styles.sectionTitle, children: "同时清理" }),
						jsx("ul", {
							style: styles.list,
							children: [
								jsx("li", { children: "工作区记账（workspace.json 中的 sessionIds）" }),
								jsx("li", { children: "投影缓存分片与缓存表项" }),
								jsx("li", { children: "会话列表中的该行（立即移除，不重新拉取）" })
							]
						})
					]
				}, "also"));

				const exclusions = Array.isArray(probe.exclusions) ? probe.exclusions : [];
				body.push(jsxs("div", {
					style: styles.ok,
					children: [
						jsx("div", {
							children: exclusions.length > 0
								? `记忆数据保护：已识别并跳过 ${String(exclusions.length)} 个记忆插件存储路径，删除不会触碰它们。`
								: "记忆数据保护已启用：只删除该会话自己的日志目录，不递归删除工作区。"
						}),
						exclusions.length > 0
							? jsxs("details", {
								style: { marginTop: 6 },
								children: [
									jsx("summary", { style: styles.hint, children: "查看受保护路径" }),
									jsx("ul", {
										style: styles.list,
										children: exclusions.map((entry) => jsx("li", {
											children: jsxs("span", { children: [
												jsx("code", { style: styles.mono, children: entry.path }),
												entry.source ? jsx("span", { style: styles.hint, children: ` （${entry.source}）` }) : null
											] })
										}, entry.path))
									})
								]
							})
							: null
					]
				}, "memory"));
			}

			if (phase === "partial" && result !== null) {
				const removed = result.removed ?? {};
				const failedDirs = Array.isArray(removed.failedDirs) ? removed.failedDirs : [];
				const failedCache = Array.isArray(removed.failedCache) ? removed.failedCache : [];
				const stateFailures = Array.isArray(removed.stateFailures) ? removed.stateFailures : [];
				body.push(jsxs("div", {
					style: styles.error,
					role: "alert",
					children: [
						jsx("div", { children: result.error?.message ?? "部分清理失败。" }),
						failedDirs.length > 0
							? jsxs("div", {
								style: { marginTop: 6 },
								children: [
									jsx("div", { style: styles.sectionTitle, children: "未能删除的目录" }),
									jsx("ul", {
										style: styles.list,
										children: failedDirs.map((entry) => jsxs("li", { children: [
											jsx("code", { style: styles.mono, children: entry.path }),
											jsx("div", { style: styles.hint, children: `${entry.code}: ${entry.message}` })
										] }, entry.path))
									})
								]
							})
							: null,
						failedCache.length > 0
							? jsxs("div", {
								style: { marginTop: 6 },
								children: [
									jsx("div", { style: styles.sectionTitle, children: "未能清理的投影缓存" }),
									jsx("ul", {
										style: styles.list,
										children: failedCache.map((entry) => jsxs("li", { children: [
											jsx("code", { style: styles.mono, children: entry.path }),
											jsx("div", { style: styles.hint, children: `${entry.code}: ${entry.message}` })
										] }, entry.path))
									})
								]
							})
							: null,
						stateFailures.length > 0
							? jsxs("div", {
								style: { marginTop: 6 },
								children: [
									jsx("div", { style: styles.sectionTitle, children: "未能清理的会话状态" }),
									jsx("ul", {
										style: styles.list,
										children: stateFailures.map((entry, index) => jsxs("li", {
											children: [
												jsx("code", { style: styles.mono, children: entry.step }),
												jsx("div", { style: styles.hint, children: entry.message })
											]
										}, `${entry.step}-${String(index)}`))
									})
								]
							})
							: null,
						jsx("div", {
							style: { marginTop: 6 },
							children: "后台复活守卫会在约 2 分钟内继续重试。若仍失败，请切换到其他会话或重启 DSH 后再点「重试清理」。"
						})
					]
				}, "partial"));
			}

			if (phase === "ready" && result !== null && result.complete === true) {
				body.push(jsx("div", { style: styles.ok, children: "清理完成，会话已从当前工作区移除。" }, "done"));
			}

			return jsx(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: "关闭",
				title: "删除会话",
				description: `「${displayTitle}」将从当前工作区永久删除，此操作不可撤销。`,
				footer,
				children: jsx("div", { style: styles.body, children: body })
			});
		}

		function DeleteSessionOverlay({ call, dropSession, refreshList }) {
			const [request, setRequest] = useState(null);
			useEffect(() => {
				dialogBus.listener = setRequest;
				return () => {
					if (dialogBus.listener === setRequest) dialogBus.listener = null;
				};
			}, []);
			if (request === null) return null;
			return jsx(DeleteSessionDialog, {
				key: request.seq,
				request,
				call,
				dropSession,
				refreshList,
				onClose: () => setRequest(null)
			});
		}

		// ── Host Remote contribution ────────────────────────────────────────
		const ANY_SCHEMA = { parse: (value) => value };
		const strictCodec = (symbol) => ({
			mode: "strict",
			typeSymbol: `${PACKAGE}/typert#${symbol}`,
			schema: ANY_SCHEMA,
			create: () => ANY_SCHEMA
		});
		const descriptorFor = (method) => ({
			id: `${PACKAGE}#sessionDelete/${method}`,
			service: "sessionDelete",
			namespace: "sessionDelete",
			method,
			invocation: { kind: "direct" },
			parameters: [{ name: "payload", wire: "payload", source: "json", codec: strictCodec("AnyValue") }],
			result: strictCodec("AnyResult"),
			sourceLocation: { file: `${PACKAGE}/lib/index.js`, line: 1, column: 1 }
		});

		async function apply(ctx) {
			const disposeRemote = await ctx.remote.$mount({
				package: PACKAGE,
				descriptors: [descriptorFor("probe"), descriptorFor("delete")]
			});

			const call = async (method, args) => {
				try {
					const service = typeof ctx.get === "function" ? ctx.get("remote.sessionDelete") : undefined;
					if (service === undefined || typeof service[method] !== "function") {
						return { ok: false, error: "Host 服务未连接（请重启 DSH 后重试）" };
					}
					const reply = await service[method](args);
					if (reply !== null && typeof reply === "object" && reply.ok === true) {
						return { ok: true, value: reply.value };
					}
					const detail = reply?.error;
					return { ok: false, error: (detail && (detail.message || detail.code)) || "Host 调用失败" };
				} catch (reason) {
					return { ok: false, error: reason instanceof Error ? reason.message : String(reason) };
				}
			};

			const dropSession = (sessionId) => {
				try {
					const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
					if (sessions !== undefined && typeof sessions.handleSessionRemoved === "function") {
						sessions.handleSessionRemoved(sessionId);
					}
				} catch (error) {
					console.warn(`[${PACKAGE}] official row removal failed`, error);
				}
			};

			const refreshList = () => {
				try {
					const sessions = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
					if (sessions !== undefined && typeof sessions.refresh === "function") {
						Promise.resolve(sessions.refresh()).catch((error) => {
							console.warn(`[${PACKAGE}] session list refresh failed`, error);
						});
					}
				} catch (error) {
					console.warn(`[${PACKAGE}] session list refresh skipped`, error);
				}
			};

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-delete-toast"
			}, Toaster));

			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-delete-dialog",
				inject: () => ({ call, dropSession, refreshList })
			}, DeleteSessionOverlay));

			ctx.slots.inject(MENU_SLOT, () => ctx.slots.register({
				name: MENU_SLOT,
				id: "delete-session",
				order: MENU_ORDER,
				inject: () => ({ requestDelete })
			}, DeleteSessionMenuItem));

			return async function cleanup() {
				try {
					await disposeRemote();
				} catch {
					// Already unmounted.
				}
			};
		}

		const inject = ["slots", "remote", "typert"];

		exports.apply = apply;
		exports.inject = inject;

		return module.exports;
	}
});
