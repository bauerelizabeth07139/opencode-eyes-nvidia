/**
 * Functional check for the host half: the plugin is loaded with
 * `@deepseek-ai/dsh-mcp-client` stubbed, its `apply()` runs against a stand-in
 * Cordis context, and the stdio mount it performs is inspected.
 *
 * Nothing is spawned — the stub's `apply` does not open a transport — so the
 * "interpreter" is an empty file in the temp directory.
 *
 * Run: `node --import ./test/hooks.mjs test/mount.test.mjs`
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, name } from "../index.js";

const EXPECTED = {
	serverName: "opencode_eyes_nvidia",
	args: ["-m","opencode_eyes_nvidia"],
	credential: "NVIDIA_API_KEY",
	envMap: {"model":"NVIDIA_MODEL","baseUrl":"NVIDIA_BASE_URL","timeoutSeconds":"NVIDIA_TIMEOUT","maxDimension":"NVIDIA_MAX_DIMENSION","jpegQuality":"NVIDIA_JPEG_QUALITY","thinkingMode":"NVIDIA_THINKING_MODE"},
	defaultTimeout: 300000,
	bridged: false,
};

const scratch = mkdtempSync(join(tmpdir(), "dsh-mount-test-"));
const FAKE_PYTHON = join(scratch, process.platform === "win32" ? "python.exe" : "python3");
writeFileSync(FAKE_PYTHON, "");

let failed = 0;
async function check(label, body) {
	try {
		const detail = await body();
		console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
	} catch (error) {
		failed++;
		console.log(`  FAIL  ${label} — ${error.message}`);
	}
}

console.log(`${name} stdio mount`);

/** A Cordis context that records what the plugin mounts. */
function makeContext() {
	const mounts = [];
	const logs = [];
	return {
		mounts,
		logs,
		plugin: async (plugin, options) => mounts.push({ plugin, options }),
		logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
	};
}

await check("apply() mounts the server over stdio with the declared argv", async () => {
	const ctx = makeContext();
	await apply(ctx, { python: FAKE_PYTHON });
	assert.equal(ctx.mounts.length, 1, `expected one mount, got ${ctx.mounts.length}`);
	const { plugin, options } = ctx.mounts[0];
	assert.equal(plugin.name, `${name}-mcp`);
	assert.equal(typeof plugin.apply, "function");
	assert.equal(options.transport, "stdio");
	assert.equal(options.serverName, EXPECTED.serverName);
	assert.equal(options.failOnStartupError, true);
	assert.ok(existsSync(options.cwd), `cwd does not exist: ${options.cwd}`);
	assert.ok(statSync(options.cwd).isDirectory(), "cwd must be a directory");
	assert.equal(options.toolCallTimeoutMs, EXPECTED.defaultTimeout);
	if (EXPECTED.bridged) {
		assert.equal(options.command, process.execPath, "the bridge runs on the harness's own Node");
		assert.match(options.args[0], /bridge\.mjs$/u, `unexpected bridge argv ${options.args[0]}`);
		assert.equal(options.args[1], "--");
		assert.equal(options.args[2], FAKE_PYTHON);
		assert.deepEqual(options.args.slice(3), EXPECTED.args);
		return `${options.serverName} via the NDJSON bridge`;
	}
	assert.equal(options.command, FAKE_PYTHON);
	assert.deepEqual(options.args, EXPECTED.args);
	return `${options.serverName} via ${options.command}`;
});

await check("the configured credential reaches the child environment", async () => {
	const ctx = makeContext();
	await apply(ctx, { python: FAKE_PYTHON, apiKey: "configured-secret" });
	const { options } = ctx.mounts[0];
	if (EXPECTED.credential === null) {
		assert.equal(Object.keys(options.env).length, 0, "no credential expected for this server");
		return "no credential needed";
	}
	assert.equal(options.env[EXPECTED.credential], "configured-secret");
	return EXPECTED.credential;
});

await check("an exported credential is forwarded despite the harness scrub", async () => {
	if (EXPECTED.credential === null) return "no credential needed";
	const previous = process.env[EXPECTED.credential];
	process.env[EXPECTED.credential] = "from-the-environment";
	try {
		const ctx = makeContext();
		await apply(ctx, { python: FAKE_PYTHON });
		assert.equal(ctx.mounts[0].options.env[EXPECTED.credential], "from-the-environment");
	} finally {
		if (previous === undefined) delete process.env[EXPECTED.credential];
		else process.env[EXPECTED.credential] = previous;
	}
	return EXPECTED.credential;
});

await check("configured environment values are passed through", async () => {
	const ctx = makeContext();
	const [key, variable] = Object.entries(EXPECTED.envMap)[0] ?? [];
	await apply(ctx, { python: FAKE_PYTHON, [key]: "configured-value", env: { EXTRA_FLAG: "raw" } });
	const { options } = ctx.mounts[0];
	assert.equal(options.env.EXTRA_FLAG, "raw");
	if (key === undefined) return "this server has no extra environment";
	assert.equal(options.env[variable], "configured-value");
	return `${variable}, EXTRA_FLAG`;
});

await check("a raised timeout is honoured", async () => {
	const ctx = makeContext();
	await apply(ctx, { python: FAKE_PYTHON, toolCallTimeoutMs: 4242 });
	assert.equal(ctx.mounts[0].options.toolCallTimeoutMs, 4242);
	return "4242 ms";
});

await check("no interpreter means a warning instead of a broken mount", async () => {
	const ctx = makeContext();
	const previousPath = process.env.PATH;
	process.env.PATH = "";
	try {
		await apply(ctx, { python: "__definitely-not-an-interpreter__" });
	} finally {
		process.env.PATH = previousPath;
	}
	assert.equal(ctx.mounts.length, 0, "nothing should be mounted");
	assert.ok(
		ctx.logs.some((message) => message.includes("no Python interpreter")),
		`expected a warning, got ${JSON.stringify(ctx.logs)}`,
	);
	return "warned, did not mount";
});

rmSync(scratch, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "all checks passed" : `${failed} check(s) failed`}`);
process.exit(failed === 0 ? 0 : 1);
