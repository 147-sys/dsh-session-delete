/**
 * dsh-session-delete — path policy.
 *
 * Everything here is about *where* a session's on-disk artifacts live and
 * *which* paths must never be deleted (the memory plugin's storage).
 *
 * The session-directory layout is copied byte-for-byte from the official
 * `@deepseek-ai/dsh-session-persistence-jsonl` backend:
 *
 *   <root>/<projectKey(cwd)>/<encodeSegment(sessionId)>
 *
 * Keeping the derivation identical (and tested against the real directory on
 * this machine) is what lets us delete exactly one session without scanning or
 * touching anything else.
 *
 * @module dsh-session-delete/paths
 */

import { existsSync, readFileSync } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Path of the projection cache's per-session shard, relative to the DSH home. */
export const PROJCACHE_DIR_PREFIX = "session_projcache";

/**
 * JSONL persistence `encodeSegment`: arbitrary string -> one safe path segment.
 * Identical to the shipped backend (special-cases `.`, `..`, escapes `~` and
 * every code unit outside `[A-Za-z0-9._-]`).
 *
 * @param {string} raw - raw segment (the session id).
 * @returns {string} filesystem-safe segment.
 */
export function encodeSegment(raw) {
	if (typeof raw !== "string" || raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

/**
 * JSONL persistence `projectKey`: project directory -> human-readable key.
 * Identical to the shipped backend.
 *
 * @param {string} cwd - absolute project directory from the session header.
 * @returns {string} directory name under the sessions root.
 */
export function projectKey(cwd) {
	if (typeof cwd !== "string" || cwd.length === 0) throw new Error("cannot encode an empty project path");
	let readable = "";
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === "/" || ch === "\\" || ch === ":") {
			if (!separatorRun) readable += "-";
			separatorRun = true;
		} else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += "~" + code.toString(16).toUpperCase().padStart(4, "0");
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/**
 * One session directory under the sessions root.
 * @param {string} sessionsRoot - `<DSH_HOME>/sessions`.
 * @param {string|undefined} cwd - session header cwd.
 * @param {string} sessionId - session id.
 * @returns {string} absolute directory path.
 */
export function sessionDirFor(sessionsRoot, cwd, sessionId) {
	return join(sessionsRoot, projectKey(cwd), encodeSegment(sessionId));
}

/**
 * Every directory that could hold the session's log. The header cwd gives the
 * authoritative location; scanning the other project directories covers a
 * session whose header cwd was missing when it was written (the backend's
 * `_no-cwd` bucket) and stale leftovers. All candidates end in the exact
 * encoded session id, so this can never name a shared directory.
 *
 * @param {string} sessionsRoot - `<DSH_HOME>/sessions`.
 * @param {string|undefined} cwd - session header cwd.
 * @param {string} sessionId - session id.
 * @returns {Promise<string[]>} candidate directories (existing or not).
 */
export async function candidateSessionDirs(sessionsRoot, cwd, sessionId) {
	const encoded = encodeSegment(sessionId);
	const candidates = new Set();
	if (typeof cwd === "string" && cwd !== "") candidates.add(join(sessionsRoot, projectKey(cwd), encoded));
	try {
		for (const entry of await readdir(sessionsRoot, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			candidates.add(join(sessionsRoot, entry.name, encoded));
		}
	} catch {
		// A missing sessions root means there is nothing to delete.
	}
	return [...candidates];
}

/**
 * Path spelling used for comparison only. Windows filesystems are
 * case-insensitive, so compare lower-case there.
 * @param {string} value - any path.
 * @returns {string} absolute normalized path.
 */
export function normalizeForCompare(value) {
	const absolute = resolve(value);
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/**
 * @param {string} parent - normalized parent path.
 * @returns {string} parent guaranteed to end in a separator.
 */
function withSeparator(parent) {
	return parent.endsWith(sep) ? parent : parent + sep;
}

/**
 * Whether `child` equals `parent` or is nested under it.
 * @param {string} child - path to test.
 * @param {string} parent - container path.
 * @returns {boolean} containment result.
 */
export function isSameOrInside(child, parent) {
	const c = normalizeForCompare(child);
	const p = normalizeForCompare(parent);
	return c === p || c.startsWith(withSeparator(p));
}

/**
 * Whether `child` is strictly nested under `parent`.
 * @param {string} child - path to test.
 * @param {string} parent - container path.
 * @returns {boolean} containment result.
 */
export function isStrictlyInside(child, parent) {
	const c = normalizeForCompare(child);
	const p = normalizeForCompare(parent);
	return c !== p && c.startsWith(withSeparator(p));
}

/**
 * Overlap between a deletion target and a protected path.
 * @param {string} target - path we intend to delete recursively.
 * @param {string} protectedPath - path that must survive.
 * @returns {"same"|"target-inside-protected"|"protected-inside-target"|null} overlap kind.
 */
export function overlapKind(target, protectedPath) {
	const t = normalizeForCompare(target);
	const p = normalizeForCompare(protectedPath);
	if (t === p) return "same";
	if (t.startsWith(withSeparator(p))) return "target-inside-protected";
	if (p.startsWith(withSeparator(t))) return "protected-inside-target";
	return null;
}

/**
 * Expand `~`, `$DSH_HOME`, `${DSH_HOME}`, `%DSH_HOME%`, `$HOME`.
 * @param {string} value - configured path text.
 * @param {string} dshHome - resolved DSH home.
 * @returns {string} expanded path text.
 */
export function expandPathVariables(value, dshHome) {
	let out = String(value).trim();
	const home = homedir();
	const replacements = [
		[/(^|[\\/])\$DSH_HOME/g, `$1${dshHome}`],
		[/(^|[\\/])\$\{DSH_HOME\}/g, `$1${dshHome}`],
		[/(^|[\\/])%DSH_HOME%/gi, `$1${dshHome}`],
		[/(^|[\\/])\$HOME/g, `$1${home}`],
		[/(^|[\\/])\$\{HOME\}/g, `$1${home}`]
	];
	for (const [pattern, replacement] of replacements) out = out.replace(pattern, replacement);
	if (out === "~") return home;
	if (out.startsWith("~/") || out.startsWith("~\\")) return join(home, out.slice(2));
	return out;
}

/**
 * Resolve the DSH home for artifact deletion.
 * @param {string|undefined} override - optional configured home.
 * @returns {string} absolute DSH home.
 */
export function resolveDshHome(override) {
	const explicit = typeof override === "string" && override.trim() !== "" ? override.trim() : undefined;
	const testIsolation = process.env.DSH_SESSION_DELETE_HOME;
	if (testIsolation !== undefined && testIsolation !== "") return resolve(expandPathVariables(testIsolation, homedir()));
	if (explicit !== undefined) return resolve(expandPathVariables(explicit, homedir()));
	const envHome = process.env.DSH_HOME;
	if (envHome !== undefined && envHome.trim() !== "") return resolve(envHome.trim());
	return resolve(homedir(), ".dsh");
}

/**
 * Parse `memoryDir` / `dbFile` out of the memory plugin's YAML patch. This is a
 * deliberately small line parser: the keys are scalar strings, no YAML engine
 * needed, and comments are ignored.
 *
 * @param {string} text - YAML document text.
 * @returns {{memoryDir?: string, dbFile?: string}} configured values (empty omitted).
 */
export function parseMemoryConfigText(text) {
	const result = {};
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.replace(/^\s*#.*$/, "");
		const match = /^\s*(memoryDir|dbFile)\s*:\s*(.*?)\s*$/.exec(line);
		if (match === null) continue;
		let value = match[2].trim();
		if (value === "" || value === "''" || value === '""') continue;
		if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) value = value.slice(1, -1);
		if (value === "") continue;
		result[match[1]] = value;
	}
	return result;
}

/**
 * Files that may carry the memory plugin's configured storage location.
 * @param {string} dshHome - resolved DSH home.
 * @param {string|undefined} profile - active profile name.
 * @returns {string[]} existing candidate patch files.
 */
export function memoryConfigCandidates(dshHome, profile) {
	const files = [];
	if (typeof profile === "string" && profile !== "") {
		files.push(join(dshHome, "profiles", profile, "cordis.patch.yml"));
		files.push(join(dshHome, "profiles", profile, "node_modules", "dsh-plugin-memory", "cordis.patch.yml"));
	}
	files.push(join(dshHome, "plugins", "dsh-plugin-memory", "cordis.patch.yml"));
	return files.filter((file) => existsSync(file));
}

/**
 * Build the full protected-path set. None of these paths are ever deletion
 * targets (targets are session directories only); the set exists so the
 * deletion path can *prove* it will not touch memory data, even if a user
 * points the sessions root somewhere unusual or the memory plugin moves.
 *
 * @param {object} options - resolution inputs.
 * @param {string} options.dshHome - resolved DSH home.
 * @param {string|undefined} options.workspacePath - owning workspace directory.
 * @param {string|undefined} options.cwd - session header cwd.
 * @param {string|undefined} options.profile - active profile name.
 * @param {string[]} options.configPaths - `memoryPathsToExclude` from plugin config.
 * @returns {Promise<Array<{path: string, source: string}>>} protected paths.
 */
export async function resolveMemoryExclusions(options) {
	const dshHome = options.dshHome;
	const workspacePath = options.workspacePath
		?? (typeof options.cwd === "string" && options.cwd !== "" ? options.cwd : undefined);
	/** @type {Array<{path: string, source: string}>} */
	const collected = [];
	const add = (value, source) => {
		if (typeof value !== "string" || value.trim() === "") return;
		const expanded = expandPathVariables(value, dshHome);
		const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(workspacePath ?? process.cwd(), expanded);
		collected.push({ path: absolute, source: source });
	};

	add(join(dshHome, "memory"), "default:$DSH_HOME/memory");
	add(join(dshHome, ".dsh-memory"), "default:$DSH_HOME/.dsh-memory");
	add(join(dshHome, "memories"), "default:$DSH_HOME/memories");
	add(process.env.DSH_MEMORY_DIR, "env:DSH_MEMORY_DIR");

	if (typeof workspacePath === "string" && workspacePath !== "") {
		add(join(workspacePath, "对话记忆"), "workspace:对话记忆");
		add(join(workspacePath, "记忆"), "workspace:记忆");
		add(join(workspacePath, ".dsh-memory"), "workspace:.dsh-memory");
		add(join(workspacePath, "memories"), "workspace:memories");
	}

	for (const file of memoryConfigCandidates(dshHome, options.profile)) {
		let text;
		try {
			text = readFileSync(file, "utf8");
		} catch {
			continue;
		}
		const parsed = parseMemoryConfigText(text);
		if (parsed.memoryDir !== undefined) add(parsed.memoryDir, `memory-plugin:${basename(file)}:memoryDir`);
		if (parsed.dbFile !== undefined) {
			const base = parsed.memoryDir !== undefined
				? resolve(expandPathVariables(parsed.memoryDir, dshHome))
				: resolve(dshHome, "memory");
			const db = isAbsolute(parsed.dbFile) ? parsed.dbFile : join(base, parsed.dbFile);
			add(db, `memory-plugin:${basename(file)}:dbFile`);
		}
	}

	for (const value of options.configPaths ?? []) add(value, "config:memoryPathsToExclude");

	const seen = new Set();
	const result = [];
	for (const entry of collected) {
		const key = normalizeForCompare(entry.path);
		if (seen.has(key)) continue;
		seen.add(key);
		result.push(entry);
	}
	return result;
}

/**
 * Prove one candidate is a session directory that may be removed recursively.
 *
 * Safety properties, in order:
 *  1. the target is named exactly the encoded session id;
 *  2. the target is strictly inside the sessions root (never the root itself);
 *  3. the target is not a symlink/junction (removal must not follow it);
 *  4. its real path is still inside the real sessions root;
 *  5. it has no overlap (in either direction) with a protected memory path.
 *
 * @param {string} target - candidate directory.
 * @param {object} options - inspection inputs.
 * @param {string} options.sessionsRoot - sessions root.
 * @param {string} options.encodedId - `encodeSegment(sessionId)`.
 * @param {Array<{path: string, source: string}>} options.exclusions - protected paths.
 * @returns {Promise<{ok: boolean, missing?: boolean, path?: string, realPath?: string, code?: string, message?: string, excluded?: object}>} inspection.
 */
export async function inspectDeletionTarget(target, options) {
	const wantedName = options.encodedId;
	const actualName = basename(target);
	const nameMatches = process.platform === "win32"
		? actualName.toLowerCase() === wantedName.toLowerCase()
		: actualName === wantedName;
	if (!nameMatches) {
		return {
			ok: false,
			code: "UNEXPECTED_TARGET_NAME",
			message: `目录名不是该会话的路径编码（期望 ${wantedName}，实际 ${actualName}）`
		};
	}
	if (!isStrictlyInside(target, options.sessionsRoot)) {
		return {
			ok: false,
			code: "OUTSIDE_SESSIONS_ROOT",
			message: `目标不在会话根目录内：${target}`
		};
	}

	let stats;
	try {
		stats = await lstat(target);
	} catch (error) {
		if (error?.code === "ENOENT") return { ok: true, missing: true, path: target };
		throw error;
	}
	if (stats.isSymbolicLink()) {
		return {
			ok: false,
			code: "SYMLINK_TARGET",
			message: `会话目录是符号链接/联接点，拒绝递归删除：${target}`
		};
	}

	let realTarget;
	try {
		realTarget = await realpath(target);
	} catch {
		realTarget = resolve(target);
	}
	let realRoot;
	try {
		realRoot = await realpath(options.sessionsRoot);
	} catch {
		realRoot = resolve(options.sessionsRoot);
	}
	if (!isStrictlyInside(realTarget, realRoot)) {
		return {
			ok: false,
			code: "OUTSIDE_SESSIONS_ROOT",
			message: `目录真实路径不在会话根目录内：${realTarget}`
		};
	}

	for (const exclusion of options.exclusions ?? []) {
		let protectedPath = exclusion.path;
		try {
			protectedPath = await realpath(protectedPath);
		} catch {
			// A protected path that does not exist is still compared by spelling.
		}
		const overlap = overlapKind(target, protectedPath) ?? overlapKind(realTarget, protectedPath);
		if (overlap !== null) {
			return {
				ok: false,
				code: "MEMORY_PROTECTED",
				message: `目标与受保护的记忆路径重叠（${overlap}）：${target} ↔ ${protectedPath}`,
				excluded: exclusion
			};
		}
	}

	return { ok: true, path: target, realPath: realTarget };
}

/**
 * Candidate projection-cache files for one session.
 * @param {string} dshHome - resolved DSH home.
 * @param {string} sessionId - session id.
 * @returns {Promise<string[]>} existing shard paths.
 */
export async function projectionShardCandidates(dshHome, sessionId) {
	const storages = join(dshHome, "storages");
	const encoded = encodeSegment(sessionId);
	const found = new Set();
	let entries;
	try {
		entries = await readdir(storages, { withFileTypes: true });
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!entry.name.startsWith(PROJCACHE_DIR_PREFIX) || !entry.isDirectory()) continue;
		for (const name of [`${sessionId}.json`, `${encoded}.json`]) {
			const file = join(storages, entry.name, "sessions", name);
			if (existsSync(file)) found.add(file);
		}
	}
	return [...found];
}

/**
 * Compact diagnostic for one path, used in warnings returned to the UI.
 * @param {string} target - path.
 * @param {string} root - root to relativize against.
 * @returns {string} relative display path.
 */
export function displayPath(target, root) {
	try {
		const rel = relative(root, target);
		return rel === "" || rel.startsWith("..") ? target : rel;
	} catch {
		return target;
	}
}
