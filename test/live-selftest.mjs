/**
 * Manual live-layout self-test.
 *
 * Exercises the real `<DSH_HOME>` sessions/storages layout with a disposable
 * fake session directory and a disposable projection shard. It never touches a
 * real session, the workspace directory, workspace.json, or the memory store.
 *
 * Usage: node test/live-selftest.mjs
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stopAllResurrectionGuards } from "../lib/delete-files.js";
import { SessionDeleteService } from "../lib/index.js";
import { encodeSegment, projectKey, resolveDshHome } from "../lib/paths.js";

const dshHome = resolveDshHome(undefined);
const workspace = process.cwd();
const sessionId = `session-selftest-${Date.now().toString(36)}`;
const sessionsRoot = join(dshHome, "sessions");
const sessionDir = join(sessionsRoot, projectKey(workspace), encodeSegment(sessionId));
const shardDir = join(dshHome, "storages", "session_projcache", "sessions");
const shard = join(shardDir, `${sessionId}.json`);
const memoryFile = join(dshHome, "memory", "memory.db");

const hash = (file) => (existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : null);
const memoryBefore = hash(memoryFile);

const calls = { detached: [], archived: [] };
const entity = {
	id: "selftest-workspace",
	title: "自检工作区",
	path: workspace,
	get sessionIds() {
		return [sessionId];
	},
	async detachSession(value) {
		calls.detached.push(value);
	}
};
const registry = {
	list: () => [entity],
	get: (value) => (value === entity.id ? entity : undefined),
	readSessionHeader: async () => ({ id: sessionId, cwd: workspace }),
	archiveSession: async (...args) => {
		calls.archived.push(args);
	},
	unarchiveSession: async () => {},
	unpinSession: async () => {},
	resolveByPath: async () => entity
};
const ctx = { get: (key) => (key === "workspaceRegistry" ? registry : undefined) };

try {
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(join(sessionDir, "session.v4.jsonl"), '{"type":"session"}\n');
	mkdirSync(shardDir, { recursive: true });
	writeFileSync(shard, "{}");

	const service = new SessionDeleteService(ctx, { memoryPathsToExclude: [] });
	const probe = await service.probe({ sessionId, workspaceId: entity.id });
	console.log("probe dirs:", probe.dirs);
	console.log("protected memory paths:", probe.exclusions.length);

	const result = await service.delete({ sessionId, workspaceId: entity.id });
	console.log("result:", JSON.stringify({
		complete: result.complete,
		detachedFrom: result.removed.detachedFrom,
		dirsRemoved: result.removed.dirsRemoved.length,
		shards: result.removed.projcacheShards.length
	}));

	assert.equal(result.complete, true);
	assert.equal(existsSync(sessionDir), false);
	assert.equal(existsSync(shard), false);
	assert.deepEqual(calls.detached, [sessionId]);
	assert.equal(hash(memoryFile), memoryBefore);
	console.log("LIVE SELFTEST PASSED: session artifacts removed, memory store unchanged");
} finally {
	stopAllResurrectionGuards();
	rmSync(sessionDir, { recursive: true, force: true });
	if (existsSync(shard)) rmSync(shard, { force: true });
}
