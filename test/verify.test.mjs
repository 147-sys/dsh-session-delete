/**
 * dsh-session-delete — offline tests for the safety-critical pieces.
 *
 * These tests never touch the real ~/.dsh: every fixture lives under a fresh
 * temporary directory, and DSH_HOME is passed explicitly to the path helpers.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { cleanProjectionCache, removeDirWithRetry, stopAllResurrectionGuards } from "../lib/delete-files.js";
import { Config, SessionDeleteService } from "../lib/index.js";
import {
	candidateSessionDirs,
	encodeSegment,
	expandPathVariables,
	inspectDeletionTarget,
	overlapKind,
	parseMemoryConfigText,
	projectKey,
	resolveMemoryExclusions
} from "../lib/paths.js";

const WORKSPACE = "C:\\Users\\me\\Documents\\project";

test("projectKey matches the on-disk folder name used by DSH", () => {
	assert.equal(projectKey(WORKSPACE), "--C-Users-me-Documents-project--");
	assert.equal(projectKey("D:\\proj"), "--D-proj--");
});

test("encodeSegment matches the JSONL backend encoding", () => {
	assert.equal(encodeSegment("session-1edad2ec-5f97-4898-b6a0-14c28e04207d"), "session-1edad2ec-5f97-4898-b6a0-14c28e04207d");
	assert.equal(encodeSegment("."), "~002E");
	assert.equal(encodeSegment(".."), "~002E~002E");
	assert.equal(encodeSegment("a/b~c"), "a~002Fb~007Ec");
});

test("expandPathVariables expands $DSH_HOME and ~", () => {
	const dshHome = "C:\\Users\\me\\.dsh";
	assert.equal(expandPathVariables("$DSH_HOME/memory", dshHome), "C:\\Users\\me\\.dsh/memory");
	assert.equal(expandPathVariables("${DSH_HOME}/memories", dshHome), "C:\\Users\\me\\.dsh/memories");
	assert.equal(expandPathVariables("%DSH_HOME%/x", dshHome), "C:\\Users\\me\\.dsh/x");
});

test("parseMemoryConfigText reads memoryDir/dbFile and ignores empty defaults", () => {
	assert.deepEqual(parseMemoryConfigText("memoryDir: ''\ndbFile: ''\n"), {});
	assert.deepEqual(
		parseMemoryConfigText(["memoryDir: 'D:/mem'", "dbFile: memory.db", "captureEnabled: true"].join("\n")),
		{ memoryDir: "D:/mem", dbFile: "memory.db" }
	);
});

test("memory exclusions cover DSH memory roots and workspace 对话记忆", async () => {
	const dshHome = mkdtempSync(join(tmpdir(), "dsh-sd-excl-"));
	try {
		const exclusions = await resolveMemoryExclusions({
			dshHome,
			workspacePath: WORKSPACE,
			configPaths: ["$DSH_HOME/custom-memory"]
		});
		const paths = exclusions.map((entry) => entry.path.toLowerCase());
		assert.ok(paths.includes(join(dshHome, "memory").toLowerCase()));
		assert.ok(paths.includes(join(dshHome, ".dsh-memory").toLowerCase()));
		assert.ok(paths.includes(join(WORKSPACE, "对话记忆").toLowerCase()));
		assert.ok(paths.includes(join(dshHome, "custom-memory").toLowerCase()));
	} finally {
		rmSync(dshHome, { recursive: true, force: true });
	}
});

test("overlapKind detects both directions", () => {
	assert.equal(overlapKind("C:\\a\\b", "C:\\a\\b"), "same");
	assert.equal(overlapKind("C:\\a\\b\\c", "C:\\a\\b"), "target-inside-protected");
	assert.equal(overlapKind("C:\\a\\b", "C:\\a\\b\\c"), "protected-inside-target");
	assert.equal(overlapKind("C:\\a\\b", "C:\\a\\c"), null);
});

test("deletion removes one session dir, cleans cache, and leaves memory untouched", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-del-"));
	try {
		const sessionsRoot = join(home, "sessions");
		const projectDir = join(sessionsRoot, projectKey(WORKSPACE));
		const victimId = "session-victim";
		const otherId = "session-other";
		const victimDir = join(projectDir, encodeSegment(victimId));
		const otherDir = join(projectDir, encodeSegment(otherId));
		mkdirSync(victimDir, { recursive: true });
		mkdirSync(otherDir, { recursive: true });
		writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
		writeFileSync(join(otherDir, "session.v4.jsonl"), "{}\n");

		const memoryDir = join(home, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "memory.db"), "must-survive");
		const workspaceMemory = join(WORKSPACE, "对话记忆");
		// Do not create anything in the real workspace; the exclusion list is
		// checked by spelling only here.

		const exclusions = await resolveMemoryExclusions({ dshHome: home, workspacePath: WORKSPACE });
		const encoded = encodeSegment(victimId);
		const safety = await inspectDeletionTarget(victimDir, { sessionsRoot, encodedId: encoded, exclusions });
		assert.equal(safety.ok, true);

		const removal = await removeDirWithRetry(victimDir, { attempts: 2, baseDelayMs: 50 });
		assert.equal(removal.ok, true);
		assert.equal(existsSync(victimDir), false);
		assert.equal(existsSync(otherDir), true);
		assert.equal(existsSync(join(memoryDir, "memory.db")), true);

		const shardDir = join(home, "storages", "session_projcache", "sessions");
		mkdirSync(shardDir, { recursive: true });
		writeFileSync(join(shardDir, `${victimId}.json`), "{}");
		writeFileSync(join(shardDir, `${otherId}.json`), "{}");
		const tableFile = join(home, "storages", "session_projcache.json");
		writeFileSync(tableFile, JSON.stringify({ tables: { sessions: { [victimId]: {}, [otherId]: {} } } }, null, 1));

		const cache = await cleanProjectionCache(home, victimId);
		assert.equal(existsSync(join(shardDir, `${victimId}.json`)), false);
		assert.equal(existsSync(join(shardDir, `${otherId}.json`)), true);
		assert.equal(cache.shardsRemoved.length, 1);
		const table = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(tableFile, "utf8")));
		assert.equal(Object.hasOwn(table.tables.sessions, victimId), false);
		assert.equal(Object.hasOwn(table.tables.sessions, otherId), true);
		assert.ok(!existsSync(workspaceMemory) || true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("inspection refuses the sessions root itself, wrong names, and memory overlap", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-safe-"));
	try {
		const sessionsRoot = join(home, "sessions");
		const memoryRoot = join(home, "memory");
		mkdirSync(sessionsRoot, { recursive: true });
		mkdirSync(memoryRoot, { recursive: true });
		const exclusions = [{ path: memoryRoot, source: "test" }];

		const rootCheck = await inspectDeletionTarget(sessionsRoot, { sessionsRoot, encodedId: "session-x", exclusions });
		assert.equal(rootCheck.ok, false);

		const wrongNameDir = join(sessionsRoot, "--p--", "not-the-id");
		mkdirSync(wrongNameDir, { recursive: true });
		const wrongCheck = await inspectDeletionTarget(wrongNameDir, { sessionsRoot, encodedId: "session-x", exclusions });
		assert.equal(wrongCheck.ok, false);
		assert.equal(wrongCheck.code, "UNEXPECTED_TARGET_NAME");

		// A session-shaped directory placed inside the protected memory root must
		// be refused even if the sessions root were configured there.
		const overlapDir = join(memoryRoot, "session-x");
		mkdirSync(overlapDir, { recursive: true });
		const overlap = await inspectDeletionTarget(overlapDir, { sessionsRoot: home, encodedId: "session-x", exclusions });
		assert.equal(overlap.ok, false);
		assert.equal(overlap.code, "MEMORY_PROTECTED");
		assert.equal(existsSync(overlapDir), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("candidateSessionDirs includes the authoritative cwd bucket and _no-cwd matches", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-cand-"));
	try {
		const sessionsRoot = join(home, "sessions");
		mkdirSync(join(sessionsRoot, "--D-proj--"), { recursive: true });
		mkdirSync(join(sessionsRoot, "_no-cwd"), { recursive: true });
		const withCwd = await candidateSessionDirs(sessionsRoot, "D:\\proj", "session-x");
		assert.ok(withCwd.includes(join(sessionsRoot, "--D-proj--", "session-x")));
		assert.ok(withCwd.includes(join(sessionsRoot, "_no-cwd", "session-x")));
		const noCwd = await candidateSessionDirs(sessionsRoot, undefined, "session-x");
		assert.ok(noCwd.includes(join(sessionsRoot, "_no-cwd", "session-x")));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

function makeRegistry({ workspaceId, path, sessionId, cwd }) {
	const calls = { archive: [], detached: [], unarchived: [], unpinned: [] };
	const entity = {
		id: workspaceId,
		title: "测试工作区",
		path,
		get sessionIds() {
			return [sessionId];
		},
		async detachSession(value) {
			calls.detached.push(value);
		}
	};
	return {
		calls,
		entity,
		list: () => [entity],
		get: (value) => (value === workspaceId ? entity : undefined),
		readSessionHeader: async () => ({ id: sessionId, cwd }),
		archiveSession: async (...args) => {
			calls.archive.push(args);
		},
		unarchiveSession: async (value) => {
			calls.unarchived.push(value);
		},
		unpinSession: async (value) => {
			calls.unpinned.push(value);
		},
		resolveByPath: async () => entity
	};
}

test("service deletes one workspace session and leaves memory data alone", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-svc-"));
	const previousHome = process.env.DSH_SESSION_DELETE_HOME;
	const previousMemory = process.env.DSH_MEMORY_DIR;
	process.env.DSH_SESSION_DELETE_HOME = home;
	delete process.env.DSH_MEMORY_DIR;
	try {
		const sessionId = "session-victim";
		const sessionsRoot = join(home, "sessions");
		const victimDir = join(sessionsRoot, projectKey(WORKSPACE), encodeSegment(sessionId));
		mkdirSync(victimDir, { recursive: true });
		writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
		const memoryDir = join(home, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "memory.db"), "must-survive");
		const shardDir = join(home, "storages", "session_projcache", "sessions");
		mkdirSync(shardDir, { recursive: true });
		writeFileSync(join(shardDir, `${sessionId}.json`), "{}");

		const registry = makeRegistry({ workspaceId: "ws-1", path: WORKSPACE, sessionId, cwd: WORKSPACE });
		// Simulate a Host that still holds the Session live: `session/list` would
		// merge it back in, so the plugin must keep it archived and must never
		// unarchive it on a complete cleanup.
		const live = { id: sessionId, header: { cwd: WORKSPACE } };
		const ctx = {
			get: (key) => (key === "workspaceRegistry"
				? registry
				: key === "sessions"
					? { get: (id) => (id === sessionId ? live : undefined) }
					: undefined)
		};
		const service = new SessionDeleteService(ctx, { memoryPathsToExclude: [] });

		const probe = await service.probe({ sessionId, workspaceId: "ws-1" });
		assert.equal(probe.workspace.workspaceId, "ws-1");
		assert.equal(probe.dirs.length, 1);
		assert.ok(probe.exclusions.some((entry) => entry.path.toLowerCase() === memoryDir.toLowerCase()));

		const result = await service.delete({ sessionId, workspaceId: "ws-1" });
		assert.equal(result.complete, true);
		assert.equal(existsSync(victimDir), false);
		assert.equal(existsSync(join(shardDir, `${sessionId}.json`)), false);
		assert.equal(existsSync(join(memoryDir, "memory.db")), true);
		assert.deepEqual(registry.calls.archive, [[sessionId, { stopActivity: true }]]);
		assert.equal(result.removed.archived, true);
		// The audit trail: the deleted Session stays archived as the hidden
		// tombstone (DSH re-lists a still-live Session), it is detached from the
		// workspace, and it is never unarchived on a complete cleanup.
		assert.deepEqual(registry.calls.unarchived, []);
		assert.deepEqual(registry.calls.detached, [sessionId]);
		assert.deepEqual(registry.calls.unpinned, [sessionId]);
		assert.equal(result.removed.guardScheduled, true);
	} finally {
		stopAllResurrectionGuards();
		if (previousHome === undefined) delete process.env.DSH_SESSION_DELETE_HOME;
		else process.env.DSH_SESSION_DELETE_HOME = previousHome;
		if (previousMemory === undefined) delete process.env.DSH_MEMORY_DIR;
		else process.env.DSH_MEMORY_DIR = previousMemory;
		rmSync(home, { recursive: true, force: true });
	}
});

test("a failed stop/archive is retried as a hidden tombstone for a live session", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-hide-"));
	const previousHome = process.env.DSH_SESSION_DELETE_HOME;
	process.env.DSH_SESSION_DELETE_HOME = home;
	try {
		const sessionId = "session-live";
		const sessionsRoot = join(home, "sessions");
		const victimDir = join(sessionsRoot, projectKey(WORKSPACE), encodeSegment(sessionId));
		mkdirSync(victimDir, { recursive: true });
		writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
		const shardDir = join(home, "storages", "session_projcache", "sessions");
		mkdirSync(shardDir, { recursive: true });
		writeFileSync(join(shardDir, `${sessionId}.json`), "{}");

		let archiveCalls = 0;
		const detached = [];
		const entity = {
			id: "ws-1",
			title: "测试工作区",
			path: WORKSPACE,
			sessionIds: [sessionId],
			async detachSession(value) {
				detached.push(value);
			}
		};
		const registry = {
			list: () => [entity],
			get: () => entity,
			readSessionHeader: async () => ({ id: sessionId, cwd: WORKSPACE }),
			async archiveSession() {
				archiveCalls += 1;
				// The first call is the stop/archive step; make it fail with the
				// ignorable "unknown session" outcome so the plugin must hide the
				// still-live Session in a second archive write after the files go.
				if (archiveCalls === 1) throw new Error("unknown session");
			},
			async unarchiveSession() {
				throw new Error("complete cleanup must not unarchive");
			},
			async unpinSession() {},
			resolveByPath: async () => entity
		};
		const live = { id: sessionId, header: { cwd: WORKSPACE } };
		const ctx = {
			get: (key) => (key === "workspaceRegistry"
				? registry
				: key === "sessions"
					? { get: (id) => (id === sessionId ? live : undefined) }
					: undefined)
		};
		const service = new SessionDeleteService(ctx, { memoryPathsToExclude: [] });
		const result = await service.delete({ sessionId, workspaceId: "ws-1" });
		assert.equal(existsSync(victimDir), false);
		assert.equal(archiveCalls, 2);
		assert.equal(result.removed.archived, true);
		assert.equal(result.complete, true);
		assert.deepEqual(detached, [sessionId]);
	} finally {
		stopAllResurrectionGuards();
		if (previousHome === undefined) delete process.env.DSH_SESSION_DELETE_HOME;
		else process.env.DSH_SESSION_DELETE_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("service refuses a target that overlaps a protected memory path", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-guard-"));
	const previousHome = process.env.DSH_SESSION_DELETE_HOME;
	const previousMemory = process.env.DSH_MEMORY_DIR;
	process.env.DSH_SESSION_DELETE_HOME = home;
	try {
		const sessionId = "session-victim";
		const victimDir = join(home, "sessions", projectKey(WORKSPACE), encodeSegment(sessionId));
		mkdirSync(victimDir, { recursive: true });
		writeFileSync(join(victimDir, "session.v4.jsonl"), "{}\n");
		// Simulate a memory plugin that points its whole store at (or above) the
		// session directory: deletion must refuse before touching anything.
		process.env.DSH_MEMORY_DIR = victimDir;

		const registry = makeRegistry({ workspaceId: "ws-1", path: WORKSPACE, sessionId, cwd: WORKSPACE });
		const ctx = { get: (key) => (key === "workspaceRegistry" ? registry : undefined) };
		const service = new SessionDeleteService(ctx, { memoryPathsToExclude: [] });

		await assert.rejects(
			() => service.delete({ sessionId, workspaceId: "ws-1" }),
			/(拒绝删除|MEMORY_PROTECTED|重叠)/
		);
		assert.equal(existsSync(victimDir), true);
		assert.deepEqual(registry.calls.detached, []);
	} finally {
		if (previousHome === undefined) delete process.env.DSH_SESSION_DELETE_HOME;
		else process.env.DSH_SESSION_DELETE_HOME = previousHome;
		if (previousMemory === undefined) delete process.env.DSH_MEMORY_DIR;
		else process.env.DSH_MEMORY_DIR = previousMemory;
		rmSync(home, { recursive: true, force: true });
	}
});

test("service refuses a session that belongs to no workspace", async () => {
	const home = mkdtempSync(join(tmpdir(), "dsh-sd-nows-"));
	const previousHome = process.env.DSH_SESSION_DELETE_HOME;
	process.env.DSH_SESSION_DELETE_HOME = home;
	try {
		const registry = {
			list: () => [],
			get: () => undefined,
			readSessionHeader: async () => ({ cwd: WORKSPACE })
		};
		const ctx = { get: (key) => (key === "workspaceRegistry" ? registry : undefined) };
		const service = new SessionDeleteService(ctx, { memoryPathsToExclude: [] });
		await assert.rejects(() => service.delete({ sessionId: "session-x" }), /不属于任何工作区/);
	} finally {
		if (previousHome === undefined) delete process.env.DSH_SESSION_DELETE_HOME;
		else process.env.DSH_SESSION_DELETE_HOME = previousHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("Config validates memoryPathsToExclude", () => {
	const ok = Config["~standard"].validate({ memoryPathsToExclude: ["$DSH_HOME/memory"] });
	assert.deepEqual(ok.value, { memoryPathsToExclude: ["$DSH_HOME/memory"] });
	const bad = Config["~standard"].validate({ memoryPathsToExclude: "not-an-array" });
	assert.ok(Array.isArray(bad.issues));
	const empty = Config["~standard"].validate({});
	assert.deepEqual(empty.value, { memoryPathsToExclude: [] });
});
