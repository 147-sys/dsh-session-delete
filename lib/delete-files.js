/**
 * dsh-session-delete — filesystem deletion primitives.
 *
 * The only recursive deletion performed anywhere in this plugin is
 * `removeDirWithRetry` on a directory that `paths.inspectDeletionTarget` has
 * already proven to be one session's own artifact directory. Workspace
 * directories are never walked or removed.
 *
 * @module dsh-session-delete/delete-files
 */

import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { encodeSegment, projectionShardCandidates } from "./paths.js";

/** Error codes Windows reports while another process still holds a handle. */
const BUSY_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY", "EACCES"]);

/**
 * @param {unknown} error - thrown value.
 * @returns {boolean} whether a retry can plausibly help.
 */
export function isBusyError(error) {
	const code = typeof error === "object" && error !== null ? error.code : undefined;
	if (typeof code === "string" && BUSY_CODES.has(code)) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\b(EBUSY|EPERM|ENOTEMPTY|EACCES)\b/i.test(message)
		|| /being used by another process/i.test(message)
		|| /另一个程序正在使用/i.test(message);
}

/**
 * @param {unknown} error - thrown value.
 * @returns {string} human-readable message.
 */
export function errorText(error) {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Remove one directory, retrying handle-contention failures with backoff and
 * verifying the directory really disappeared. A symlink is unlinked, never
 * followed.
 *
 * @param {string} dir - directory to remove (must already be safety-checked).
 * @param {object} [options] - retry policy.
 * @param {number} [options.attempts] - total attempts.
 * @param {number} [options.baseDelayMs] - first backoff delay.
 * @returns {Promise<{ok: boolean, attempts: number, missing?: boolean, symlink?: boolean, code?: string, message?: string, error?: unknown}>} outcome.
 */
export async function removeDirWithRetry(dir, options = {}) {
	const attempts = Math.max(1, options.attempts ?? 4);
	const baseDelayMs = Math.max(50, options.baseDelayMs ?? 400);
	let lastError;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			let stats;
			try {
				stats = await lstat(dir);
			} catch (error) {
				if (error?.code === "ENOENT") return { ok: true, attempts: attempt, missing: true };
				throw error;
			}
			if (stats.isSymbolicLink()) {
				await unlink(dir);
				return { ok: true, attempts: attempt, symlink: true };
			}
			await rm(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
			if (!existsSync(dir)) return { ok: true, attempts: attempt };
			const stillPresent = new Error(`目录在删除后仍然存在：${dir}`);
			stillPresent.code = "STILL_PRESENT";
			lastError = stillPresent;
		} catch (error) {
			lastError = error;
			if (!isBusyError(error)) break;
		}
		if (attempt < attempts) await sleep(baseDelayMs * attempt);
	}
	return {
		ok: false,
		attempts,
		code: typeof lastError?.code === "string" ? lastError.code : "STILL_PRESENT",
		message: errorText(lastError),
		error: lastError
	};
}

/**
 * Clean one session's projection-cache artifacts.
 *
 * Current DSH stores the cache as `per-record` JSON shards
 * (`<storages>/session_projcache/sessions/<id>.json`, plus archive-domain
 * variants). Older layouts kept one table document at
 * `<storages>/session_projcache.json`. Both are cleaned here, and only the
 * exact session key is removed from a table document.
 *
 * @param {string} dshHome - resolved DSH home.
 * @param {string} sessionId - session id.
 * @returns {Promise<{shardsRemoved: string[], tablesUpdated: string[], failed: Array<{path: string, code: string, message: string}>}>} outcome.
 */
export async function cleanProjectionCache(dshHome, sessionId) {
	const storages = join(dshHome, "storages");
	const encoded = encodeSegment(sessionId);
	const shardsRemoved = [];
	const tablesUpdated = [];
	const failed = [];

	const shards = await projectionShardCandidates(dshHome, sessionId);
	for (const shard of shards) {
		try {
			await rm(shard, { force: true, maxRetries: 2, retryDelay: 50 });
			if (!existsSync(shard)) shardsRemoved.push(shard);
			else failed.push({ path: shard, code: "STILL_PRESENT", message: "投影缓存分片删除后仍然存在" });
		} catch (error) {
			failed.push({ path: shard, code: typeof error?.code === "string" ? error.code : "STILL_PRESENT", message: errorText(error) });
		}
	}

	let entries;
	try {
		entries = await readdir(storages, { withFileTypes: true });
	} catch {
		entries = [];
	}
	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.startsWith("session_projcache") || !entry.name.endsWith(".json")) continue;
		const file = join(storages, entry.name);
		try {
			const raw = readFileSync(file, "utf8");
			const parsed = JSON.parse(raw);
			const table = parsed?.tables?.sessions;
			if (table === null || typeof table !== "object" || !Object.hasOwn(table, sessionId)) continue;
			delete table[sessionId];
			const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
			try {
				await writeFile(temporary, JSON.stringify(parsed, null, 1), "utf8");
				await rename(temporary, file);
				tablesUpdated.push(file);
			} finally {
				if (existsSync(temporary)) await rm(temporary, { force: true }).catch(() => {});
			}
		} catch (error) {
			failed.push({ path: file, code: typeof error?.code === "string" ? error.code : "PROJCACHE_TABLE", message: errorText(error) });
		}
	}

	return { shardsRemoved, tablesUpdated, failed };
}

/**
 * Re-check a set of paths and report the survivors.
 * @param {string[]} paths - paths that must no longer exist.
 * @returns {string[]} surviving paths.
 */
export function survivingPaths(paths) {
	return paths.filter((path) => existsSync(path));
}

/** Module-level resurrection guards: one timer chain per session. */
const resurrectionGuards = new Map();

/**
 * Windows live-deletion race: a live session's teardown can append to (and so
 * recreate) the deleted directory, and a handle released late can make the
 * first `rm` fail. This guard re-checks the same exact session directories for
 * a bounded window and deletes them again if they reappear.
 *
 * @param {string} key - guard key (session id).
 * @param {() => Promise<void>} tick - re-check and re-delete callback.
 * @param {object} [options] - timing.
 * @param {number} [options.baseDelayMs] - first delay.
 * @param {number} [options.maxDelayMs] - maximum single delay.
 * @param {number} [options.totalMs] - total guard window.
 * @returns {boolean} whether a guard was scheduled.
 */
export function scheduleResurrectionGuard(key, tick, options = {}) {
	stopResurrectionGuard(key);
	const baseDelayMs = options.baseDelayMs ?? 2_000;
	const maxDelayMs = options.maxDelayMs ?? 32_000;
	const totalMs = options.totalMs ?? 120_000;
	const startedAt = Date.now();
	let delay = baseDelayMs;

	const run = async () => {
		try {
			await tick();
		} catch {
			// A transient filesystem failure is retried at the next step.
		}
		const nextDelay = delay * 2;
		if (Date.now() - startedAt + nextDelay > totalMs) {
			resurrectionGuards.delete(key);
			return;
		}
		delay = Math.min(nextDelay, maxDelayMs);
		resurrectionGuards.set(key, setTimeout(run, delay));
	};
	resurrectionGuards.set(key, setTimeout(run, delay));
	return true;
}

/**
 * Stop one session's resurrection guard.
 * @param {string} key - guard key.
 * @returns {void}
 */
export function stopResurrectionGuard(key) {
	const timer = resurrectionGuards.get(key);
	if (timer !== undefined) {
		clearTimeout(timer);
		resurrectionGuards.delete(key);
	}
}

/**
 * Stop every resurrection guard (plugin disposal).
 * @returns {void}
 */
export function stopAllResurrectionGuards() {
	for (const timer of resurrectionGuards.values()) clearTimeout(timer);
	resurrectionGuards.clear();
}

/**
 * Human-friendly hint for a failed directory removal.
 * @param {string} code - failure code.
 * @returns {string} hint.
 */
export function removalHint(code) {
	if (code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES" || code === "STILL_PRESENT") {
		return "文件可能仍被 DSH 进程占用（Windows 上的活体文件句柄）。请切换到其他会话后重试；插件已在后台继续重试约 2 分钟。";
	}
	return "请查看 DSH 日志中的详细错误，并在会话目录不再被占用后重试。";
}
