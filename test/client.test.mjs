/**
 * Structural test for the browser bundle: the module registers under the
 * package id, `apply` mounts the Remote contribution, and the three slot
 * contributions are installed without touching a real browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

test("client bundle registers, mounts the remote, and installs its slots", async () => {
	let definition;
	globalThis.window = {
		__ModuleLoader__: {
			load(value) {
				definition = value;
			}
		}
	};

	await import("../lib/client.js");
	assert.equal(definition.id, "dsh-session-delete");
	assert.equal(typeof definition.factory, "function");

	const reactStub = { useState: () => [null, () => {}], useEffect: () => {}, createElement: () => null };
	const jsxStub = {
		jsx: (type, props) => ({ type, props }),
		jsxs: (type, props) => ({ type, props }),
		Fragment: "Fragment"
	};
	const primitivesStub = {
		MenuItemButton: "MenuItemButton",
		IconTrashOutlineRegular: "IconTrashOutlineRegular"
	};
	const requireShim = (spec) => {
		if (spec === "react") return reactStub;
		if (spec === "react/jsx-runtime") return jsxStub;
		if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
		throw new Error(`unexpected require: ${spec}`);
	};

	const module = definition.factory(requireShim);
	assert.equal(typeof module.apply, "function");
	assert.deepEqual(module.inject, ["slots", "remote", "typert"]);

	const registered = [];
	let mounted;
	let disposed = false;
	const ctx = {
		remote: {
			async $mount(contribution) {
				mounted = contribution;
				return async () => {
					disposed = true;
				};
			}
		},
		slots: {
			inject(name, callback) {
				const result = callback();
				registered.push({ name, result });
				return () => {};
			},
			register(registration, component) {
				return { registration, component };
			}
		},
		get: () => undefined
	};

	const cleanup = await module.apply(ctx);
	assert.equal(mounted.package, "dsh-session-delete");
	assert.deepEqual(mounted.descriptors.map((descriptor) => descriptor.method), ["probe", "delete"]);
	assert.deepEqual(registered.map((entry) => entry.name), [
		"shell.overlay",
		"shell.overlay",
		"sidebar.workspaces.session.menu.item"
	]);
	assert.equal(registered[2].result.registration.id, "delete-session");
	assert.equal(registered[2].result.registration.order, 500);

	// The row component only uses the hooks the slot injects, so it can be
	// called directly: it must hide outside a workspace and request the
	// confirmation dialog for a workspace session.
	const menu = registered[2].result.component;
	const workspaceState = {
		items: [{ workspaceId: "ws-1", title: "工作区", path: "C:\\ws", sessionIds: ["s1"] }]
	};
	const useWorkspaces = (selector) => selector(workspaceState);
	let openState = null;
	const setMenuOpen = (value) => {
		openState = value;
	};
	let requested = null;
	const element = menu({
		sessionId: "s1",
		displayTitle: "会话标题",
		useWorkspaces,
		useMenuOpenState: () => [false, setMenuOpen],
		requestDelete: (request) => {
			requested = request;
		}
	});
	assert.equal(element.type, "MenuItemButton");
	assert.equal(element.props.danger, true);
	element.props.onSelect();
	assert.equal(openState, false);
	assert.equal(requested.sessionId, "s1");
	assert.equal(requested.workspace.workspaceId, "ws-1");
	assert.equal(requested.workspace.path, "C:\\ws");

	const hidden = menu({
		sessionId: "s2",
		displayTitle: "无工作区",
		useWorkspaces: (selector) => selector({ items: [] }),
		useMenuOpenState: () => [false, () => {}],
		requestDelete: () => {}
	});
	assert.equal(hidden, null);

	await cleanup();
	assert.equal(disposed, true);
	delete globalThis.window;
});
