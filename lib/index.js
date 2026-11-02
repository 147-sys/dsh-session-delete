/**
 * dsh-session-delete — Host half.
 *
 * A plain Cordis plugin (no third-party runtime dependency) that registers the
 * `sessionDelete` service and exposes it to the browser through the official
 * Typert Remote SRC channel — the same public path third-party bundles use.
 * The browser half mounts two methods:
 *
 *   probe(payload)  -> what would be deleted, whether the session is running,
 *                      and the protected memory paths
 *   delete(payload) -> the deletion pipeline
 *
 * Deletion pipeline (deliberately in this order):
 *
 *   1. stop running work through `workspaceRegistry.archiveSession(...,
 *      { stopActivity: true })` and wait for the Agent to leave `running`;
 *      this also leaves the Session archived as the hidden tombstone;
 *   2. flush the live session's buffered events;
 *   3. remove ONLY the session's own log directories under
 *      `<DSH_HOME>/sessions/<projectKey>/<encodedId>`;
 *   4. clean the projection-cache shard and table entry;
 *   5. verify the artifacts are gone (Windows live-deletion race);
 *   6. on complete file cleanup, detach workspace accounting and keep the
 *      archive flag — DSH's `session/list` re-lists any Session the Host still
 *      holds live, so unarchiving here would resurrect the deleted row under
 *      Ungrouped. On a partial cleanup, unarchive and keep the workspace
 *      membership so the row stays visible and retryable;
 *   7. schedule a short resurrection guard that re-deletes a directory
 *      recreated by a late teardown append.
 *
 * Memory safety: the workspace directory is never recursively deleted. Every
 * recursive `rm` target is first proven to be one encoded session directory
 * inside the sessions root and to have no overlap with any protected memory
 * path (see `paths.inspectDeletionTarget`) — including `~/.dsh/memory`,
 * `~/.dsh/.dsh-memory`, `$DSH_HOME/memories`, `$DSH_MEMORY_DIR`, the memory
 * plugin's configured `memoryDir`/`dbFile`, `<workspace>/对话记忆`, and every
 * entry of the user's `memoryPathsToExclude`.
 *
 * @module dsh-session-delete
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import z from "@deepseek-ai/schemastery";

import {
	cleanProjectionCache,
	errorText,
	removeDirWithRetry,
	removalHint,
	scheduleResurrectionGuard,
	stopAllResurrectionGuards,
	survivingPaths
} from "./delete-files.js";
import {
	candidateSessionDirs,
	encodeSegment,
	inspectDeletionTarget,
	normalizeForCompare,
	resolveDshHome,
	resolveMemoryExclusions
} from "./paths.js";

/** Marker key read by the Typert Gateway's SRC fallback. */
const REMOTE_METHOD_DESCRIPTOR = "@deepseek-ai/dsh-typert-protocol/remote-methods";

/** Session ids are path-encoded anyway; this bound keeps diagnostics sane. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;

/**
 * Plugin configuration. `memoryPathsToExclude` is the user-facing escape hatch
 * for memory-plugin storage that automatic detection cannot see. Accepts
 * absolute paths, `~`, `$DSH_HOME`, `%DSH_HOME%`, or workspace-relative paths.
 * Schemastery also gives the settings UI a generated form for this key.
 */
export const Config = z.object({
	memoryPathsToExclude: z.array(z.string()).default([])
});

/**
 * @param {unknown} config - raw plugin config.
 * @returns {{memoryPathsToExclude: string[]}} normalized config.
 */
function normalizeConfig(config) {
	const source = config !== null && typeof config === "object" ? config : {};
	return {
		memoryPathsToExclude: Array.isArray(source.memoryPathsToExclude)
			? source.memoryPathsToExclude.filter((entry) => typeof entry === "string" && entry.trim() !== "")
			: []
	};
}

/**
 * Attach the SRC Remote markers. The gateway reads this descriptor from the
 * live service prototype and derives the wire arguments from the method
 * signatures, so no generated Typert artifact is needed.
 *
 * @param {object} prototype - service prototype.
 * @param {string[]} methods - exported method names.
 * @returns {void}
 */
function markRemoteMethods(prototype, methods) {
	Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
		configurable: true,
		value: Object.freeze({
			version: 1,
			methods: Object.freeze(methods.map((method) => Object.freeze({
				method,
				invocation: Object.freeze({ kind: "direct" })
			})))
		})
	});
}

/**
 * @param {unknown} value - candidate.
 * @returns {string|undefined} trimmed non-empty string.
 */
function optionalString(value) {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * @param {string|undefined} left - path.
 * @param {string|undefined} right - path.
 * @returns {boolean} whether both spell the same path.
 */
function samePath(left, right) {
	if (typeof left !== "string" || typeof right !== "string") return false;
	return normalizeForCompare(left) === normalizeForCompare(right);
}

/**
 * @param {string} path - path to shorten.
 * @returns {string} last segment.
 */
function lastSegment(path) {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length === 0 ? path : parts[parts.length - 1];
}

/** Host service value registered as `ctx.sessionDelete`. */
export class SessionDeleteService {
	/**
	 * @param {import("@deepseek-ai/cordis").Context} ctx - owning context.
	 * @param {{memoryPathsToExclude: string[]}} config - normalized config.
	 */
	constructor(ctx, config) {
		this.ctx = ctx;
		this.config = config;
	}

	/** @returns {string} resolved DSH home. */
	dshHome() {
		return resolveDshHome(undefined);
	}

	/** @returns {string} sessions root. */
	sessionsRoot() {
		return join(this.dshHome(), "sessions");
	}

	/** @returns {object} the durable workspace registry. */
	requireRegistry() {
		const registry = this.ctx.get("workspaceRegistry");
		if (registry === undefined || registry === null) {
			throw new Error("workspaceRegistry 服务不可用（工作区插件未加载）");
		}
		return registry;
	}

	/**
	 * @param {unknown} payload - Remote payload.
	 * @returns {string} validated session id.
	 */
	requireSessionId(payload) {
		const id = optionalString(payload?.sessionId);
		if (id === undefined) throw new Error("sessionId 不能为空");
		if (!SESSION_ID_PATTERN.test(id)) {
			throw new Error(`sessionId 含有非法字符或长度异常：${JSON.stringify(id.slice(0, 80))}`);
		}
		return id;
	}

	/**
	 * Read the immutable session-header cwd. Live header first, then the
	 * registry's header index, then the persistence snapshot.
	 *
	 * @param {string} sessionId - session id.
	 * @returns {Promise<string|undefined>} cwd when known.
	 */
	async readCwd(sessionId) {
		const live = this.ctx.get("sessions")?.get?.(sessionId);
		const liveCwd = live?.header?.cwd;
		if (typeof liveCwd === "string" && liveCwd !== "") return liveCwd;

		const registry = this.requireRegistry();
		if (typeof registry.readSessionHeader === "function") {
			try {
				const header = await registry.readSessionHeader(sessionId);
				if (typeof header?.cwd === "string" && header.cwd !== "") return header.cwd;
			} catch {
				// Fall through to the persistence snapshot.
			}
		}

		const persistence = this.ctx.get("sessionPersistence");
		if (persistence !== undefined && typeof persistence.stat === "function") {
			try {
				const snapshot = await persistence.stat(sessionId);
				const cwd = snapshot?.header?.cwd;
				if (typeof cwd === "string" && cwd !== "") return cwd;
			} catch {
				// No stored session (or it was already removed).
			}
		}
		return undefined;
	}

	/**
	 * Resolve and authorize the owning workspace.
	 *
	 * The plugin only deletes workspace-accounted sessions. A retry after a
	 * partial cleanup may arrive once the session has already been detached, so
	 * `allowDetached` accepts a session whose cwd still canonically matches the
	 * requested workspace.
	 *
	 * @param {string} sessionId - session id.
	 * @param {string|undefined} workspaceId - workspace selected in the UI.
	 * @param {string|undefined} cwd - session cwd.
	 * @param {boolean} allowDetached - retry authorization.
	 * @returns {Promise<object>} workspace entity.
	 */
	async findWorkspace(sessionId, workspaceId, cwd, allowDetached) {
		const registry = this.requireRegistry();
		const all = registry.list();
		let entity;
		if (workspaceId !== undefined) {
			entity = registry.get(workspaceId);
			if (entity === undefined) throw new Error(`工作区不存在：${workspaceId}`);
		}
		const accounted = all.filter((candidate) => Array.isArray(candidate.sessionIds) && candidate.sessionIds.includes(sessionId));
		if (entity === undefined) entity = accounted[0];
		if (entity === undefined && typeof cwd === "string" && cwd !== "") {
			try {
				entity = await registry.resolveByPath(cwd);
			} catch {
				entity = undefined;
			}
			if (entity === undefined) entity = all.find((candidate) => samePath(candidate.path, cwd));
		}
		if (entity === undefined) {
			throw new Error("该会话不属于任何工作区；本插件只删除工作区下的会话");
		}

		const inEntity = Array.isArray(entity.sessionIds) && entity.sessionIds.includes(sessionId);
		if (!inEntity && !allowDetached) {
			const elsewhere = accounted.find((candidate) => candidate.id !== entity.id);
			if (elsewhere !== undefined) {
				throw new Error(`该会话属于工作区「${elsewhere.title}」，不是当前工作区「${entity.title}」`);
			}
			if (!samePath(entity.path, cwd)) {
				throw new Error(`该会话不在当前工作区「${entity.title}」中（会话目录：${cwd ?? "未知"}）`);
			}
		}
		return entity;
	}

	/**
	 * @param {object} entity - workspace entity.
	 * @param {string|undefined} cwd - session cwd.
	 * @returns {Promise<Array<{path: string, source: string}>>} protected paths.
	 */
	async memoryExclusions(entity, cwd) {
		return resolveMemoryExclusions({
			dshHome: this.dshHome(),
			profile: process.env.DSH_PROFILE,
			workspacePath: entity.path,
			cwd,
			configPaths: this.config.memoryPathsToExclude
		});
	}

	/**
	 * Resolve one deletion request into an authorized, safety-checked plan.
	 *
	 * @param {object} payload - Remote payload.
	 * @param {boolean} allowDetached - permit a retry after detaching.
	 * @returns {Promise<object>} plan.
	 */
	async plan(payload, allowDetached) {
		const sessionId = this.requireSessionId(payload);
		const workspaceId = optionalString(payload?.workspaceId);
		const cwd = await this.readCwd(sessionId);
		const entity = await this.findWorkspace(sessionId, workspaceId, cwd, allowDetached);
		const exclusions = await this.memoryExclusions(entity, cwd);
		const sessionsRoot = this.sessionsRoot();
		const encodedId = encodeSegment(sessionId);
		const candidates = await candidateSessionDirs(sessionsRoot, cwd, sessionId);

		const inspect = async (dir) => inspectDeletionTarget(dir, { sessionsRoot, encodedId, exclusions });
		const dirs = [];
		for (const dir of candidates) {
			if (!existsSync(dir)) continue;
			const safety = await inspect(dir);
			if (!safety.ok) throw new Error(`已拒绝删除：${safety.message}`);
			dirs.push(dir);
		}

		return {
			sessionId,
			workspaceId: entity.id,
			workspace: entity,
			cwd,
			exclusions,
			sessionsRoot,
			encodedId,
			candidates,
			dirs,
			inspect
		};
	}

	/**
	 * Probe one session for the confirmation dialog.
	 *
	 * @param {{sessionId?: string, workspaceId?: string, retry?: boolean}} payload - request.
	 * @returns {Promise<object>} probe value.
	 */
	async probe(payload) {
		const planned = await this.plan(payload, payload?.retry === true);
		const live = this.ctx.get("sessions")?.get?.(planned.sessionId) !== undefined;
		let running = false;
		try {
			const agent = this.ctx.get("agents")?.get?.(planned.sessionId);
			running = agent?.status === "running";
		} catch {
			running = false;
		}

		const dirs = [];
		for (const dir of planned.dirs) {
			const safety = await planned.inspect(dir);
			dirs.push({
				path: dir,
				safe: safety.ok,
				code: safety.code ?? null,
				message: safety.message ?? null
			});
		}

		return {
			sessionId: planned.sessionId,
			workspace: {
				workspaceId: planned.workspace.id,
				title: planned.workspace.title,
				path: planned.workspace.path
			},
			cwd: planned.cwd ?? null,
			running,
			live,
			sessionsRoot: planned.sessionsRoot,
			dirs,
			exclusions: planned.exclusions.map((entry) => ({ path: entry.path, source: entry.source })),
			hasLogDir: dirs.length > 0
		};
	}

	/**
	 * Delete one workspace session.
	 *
	 * @param {{sessionId?: string, workspaceId?: string, retry?: boolean}} payload - request.
	 * @returns {Promise<object>} structured outcome; partial failures are reported, never swallowed.
	 */
	async delete(payload) {
		const planned = await this.plan(payload, payload?.retry === true);
		const { sessionId, cwd, sessionsRoot, exclusions, dirs } = planned;
		const registry = this.requireRegistry();
		const dshHome = this.dshHome();

		/** @type {string[]} */
		const warnings = [];
		/** @type {Array<{path: string, code: string, message: string, hint: string}>} */
		const failedDirs = [];
		/** @type {string[]} */
		const dirsRemoved = [];
		/** @type {string[]} */
		const detachedFrom = [];
		/** @type {Array<{step: string, workspaceId?: string, message: string}>} */
		const stateFailures = [];
		let stoppedWork = false;
		/** Whether the Session is (or was left) archived as the hidden tombstone. */
		let archived = false;
		let flushed = false;
		let unarchived = false;
		let unpinned = false;

		// 1. Stop running work. `stopActivity` writes the durable archive gate
		// first, so a stopped agent cannot start another turn before we delete.
		// It also archives the Session, which doubles as the hidden tombstone:
		// DSH's `session/list` merges live Sessions held in the Host's memory,
		// and a plugin cannot evict that entry, so an unarchived deleted Session
		// is re-added to the sidebar under Ungrouped after any list refresh.
		try {
			await registry.archiveSession(sessionId, { stopActivity: true });
			stoppedWork = true;
			archived = true;
		} catch (error) {
			const message = errorText(error);
			if (!/unknown session/i.test(message)) {
				warnings.push(`停止会话失败：${message}`);
				stateFailures.push({ step: "stop-activity", message });
			}
		}

		// 2. Wait briefly for the Agent to actually leave `running`; deleting
		//    under an active turn is the main Windows handle-contention source.
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			let running = false;
			try {
				running = this.ctx.get("agents")?.get?.(sessionId)?.status === "running";
			} catch {
				running = false;
			}
			if (!running) break;
			await sleep(200);
		}
		let stillRunning = false;
		try {
			stillRunning = this.ctx.get("agents")?.get?.(sessionId)?.status === "running";
		} catch {
			stillRunning = false;
		}
		if (stillRunning) {
			throw new Error("会话在停止请求后仍处于运行状态，已中止删除以免破坏正在写入的日志");
		}
		// 3. Flush buffered events before the files disappear.
		const sessionsService = this.ctx.get("sessions");
		const live = sessionsService?.get?.(sessionId);
		if (live !== undefined && typeof sessionsService?.flush === "function") {
			try {
				await sessionsService.flush(live);
				flushed = true;
			} catch (error) {
				warnings.push(`写入缓冲事件失败（继续删除）：${errorText(error)}`);
			}
		}

		// 4. Remove only the proven session directories. Workspace membership is
		//    kept until the files are actually gone: a failed cleanup must remain
		//    in its project (still deletable) instead of being dumped into
		//    Ungrouped with no delete entry.
		for (const dir of dirs) {
			const safety = await planned.inspect(dir);
			if (!safety.ok) {
				failedDirs.push({
					path: dir,
					code: safety.code ?? "UNSAFE_TARGET",
					message: safety.message ?? "目标未通过安全校验",
					hint: "该路径与受保护路径冲突，已跳过。"
				});
				continue;
			}
			const result = await removeDirWithRetry(dir, { attempts: 4, baseDelayMs: 400 });
			if (result.ok) {
				dirsRemoved.push(dir);
			} else {
				failedDirs.push({
					path: dir,
					code: result.code,
					message: result.message,
					hint: removalHint(result.code)
				});
			}
		}

		// 5. Projection cache (shards + legacy table entries).
		const cache = await cleanProjectionCache(dshHome, sessionId);

		// 6. Verification pass: Windows can recreate the directory from a late
		//    teardown append after `rm` returned success.
		await sleep(300);
		const survivors = survivingPaths([...dirs, ...cache.shardsRemoved]);
		for (const survivor of survivors) {
			if (failedDirs.some((failure) => samePath(failure.path, survivor))) continue;
			failedDirs.push({
				path: survivor,
				code: "RECREATED_AFTER_DELETE",
				message: "删除后复查时该路径再次出现（可能有迟到的写入）",
				hint: removalHint("STILL_PRESENT")
			});
		}

		// 7. Bookkeeping after the files are gone.
		//
		//    Complete file cleanup: detach workspace accounting through the
		//    official entity method (never hand-edit workspace.json) and leave
		//    the archive flag in place. That flag is the only thing that can hide
		//    a deleted Session the Host still holds live; after the next DSH
		//    restart it is a harmless dangling archive id.
		//
		//    Partial file cleanup: unarchive so the row is visible again and
		//    keep its workspace membership, otherwise the user is left with an
		//    Ungrouped row that has no "删除会话" entry to retry with.
		const fileCleanupFailed = failedDirs.length > 0 || cache.failed.length > 0 || survivors.length > 0;
		if (fileCleanupFailed) {
			try {
				await registry.unarchiveSession(sessionId);
				unarchived = true;
			} catch (error) {
				const message = errorText(error);
				warnings.push(`恢复会话可见性失败：${message}`);
				stateFailures.push({ step: "unarchive", message });
			}
		} else {
			for (const entity of registry.list()) {
				const ids = entity.sessionIds;
				if (!Array.isArray(ids) || !ids.includes(sessionId)) continue;
				try {
					await entity.detachSession(sessionId);
					detachedFrom.push(entity.id);
				} catch (error) {
					const message = errorText(error);
					warnings.push(`从工作区「${entity.title}」解绑失败：${message}`);
					stateFailures.push({ step: "detach", workspaceId: entity.id, message });
				}
			}
			try {
				await registry.unpinSession(sessionId);
				unpinned = true;
			} catch (error) {
				// A cold Session no longer exists after its files are gone; the
				// archive write in step 1 already cleared the pin, so a failure
				// here is not a deletion failure.
				const message = errorText(error);
				if (!/unknown session/i.test(message)) warnings.push(`取消置顶失败：${message}`);
			}
			if (!archived && this.ctx.get("sessions")?.get?.(sessionId) !== undefined) {
				try {
					await registry.archiveSession(sessionId);
					archived = true;
				} catch (error) {
					const message = errorText(error);
					warnings.push(`隐藏会话记录失败：${message}`);
					stateFailures.push({ step: "hide", message });
				}
			}
		}

		// 8. Bounded resurrection guard for the live-deletion race.
		scheduleResurrectionGuard(sessionId, async () => {
			for (const dir of await candidateSessionDirs(sessionsRoot, cwd, sessionId)) {
				if (!existsSync(dir)) continue;
				const safety = await planned.inspect(dir);
				if (!safety.ok) return;
				await removeDirWithRetry(dir, { attempts: 2, baseDelayMs: 200 });
			}
			await cleanProjectionCache(dshHome, sessionId);
		});

		const failedCache = [...cache.failed];
		const complete = failedDirs.length === 0
			&& failedCache.length === 0
			&& survivors.length === 0
			&& stateFailures.length === 0;

		const failureParts = [];
		if (failedDirs.length > 0) {
			failureParts.push(
				`${String(failedDirs.length)} 个会话日志目录未清理：`
				+ failedDirs.slice(0, 3).map((failure) => `${lastSegment(failure.path)}（${failure.code}）`).join("；")
			);
		}
		if (failedCache.length > 0) {
			failureParts.push(
				`${String(failedCache.length)} 个投影缓存项未清理：`
				+ failedCache.slice(0, 3).map((failure) => `${lastSegment(failure.path)}（${failure.code}）`).join("；")
			);
		}
		if (survivors.length > 0 && failedDirs.length === 0) {
			failureParts.push(`${String(survivors.length)} 个路径在删除后复查时仍存在`);
		}
		if (stateFailures.length > 0) {
			failureParts.push(
				`${String(stateFailures.length)} 项会话状态清理失败：`
				+ stateFailures.slice(0, 3).map((failure) => `${failure.step}（${failure.message}）`).join("；")
			);
		}

		const hint = failedDirs[0]?.hint ?? (failedCache.length > 0 ? removalHint(failedCache[0].code) : undefined);

		return {
			sessionId,
			complete,
			removed: {
				stoppedWork,
				flushed,
				archived,
				unarchived,
				unpinned,
				detachedFrom,
				dirsRemoved,
				failedDirs,
				projcacheShards: cache.shardsRemoved,
				projcacheTables: cache.tablesUpdated,
				failedCache,
				survivors,
				stateFailures,
				guardScheduled: true,
				warnings
			},
			error: complete ? null : {
				code: "PARTIAL_CLEANUP",
				message: `${failureParts.join("；")}。${hint ?? ""}`.trim()
			}
		};
	}
}

markRemoteMethods(SessionDeleteService.prototype, ["probe", "delete"]);

export const name = "session-delete";
export const inject = [];

/**
 * Cordis plugin entry.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - plugin context.
 * @param {unknown} config - validated plugin config.
 * @returns {void}
 */
export function apply(ctx, config) {
	const service = new SessionDeleteService(ctx, normalizeConfig(config));
	service.typertRemote = Object.freeze({
		service,
		serviceKey: "sessionDelete",
		namespace: "sessionDelete"
	});
	ctx.provide("sessionDelete", service);
	ctx.effect(() => () => stopAllResurrectionGuards(), "session-delete.resurrection-guards");
}
