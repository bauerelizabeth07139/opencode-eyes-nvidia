/**
 * `dsh-opencode-eyes-nvidia` — a DeepSeek Harness host plugin that mounts the
 * `opencode_eyes_nvidia` MCP server shipped in this repository.
 *
 * The server speaks MCP over stdio. The plugin resolves a Python interpreter,
 * hands the server its argv and working directory, and passes the credentials
 * the server needs explicitly: the harness scrubs credential-shaped variables
 * (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`) out of the environment a child would
 * inherit, so a key merely exported in the shell would never reach the server.
 *
 * `The server is a `src/`-layout module (`python -m opencode_eyes_nvidia`), so
 * it starts with the repository's `src` directory as its working directory.
 * Every NVIDIA key variable is forwarded explicitly: the harness scrubs
 * credential-shaped variables out of an inherited environment, and the
 * rotation ring (`NVIDIA_API_KEYS`, `NVIDIA_API_KEY_1..N`) goes through `env`.`
 *
 * @module dsh-opencode-eyes-nvidia
 */

import { dirname, delimiter, join } from "node:path";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
	apply as applyMcpClient,
	Config as McpClientConfig,
	inject as mcpClientInject,
	name as mcpClientName,
} from "@deepseek-ai/dsh-mcp-client";

/** Plugin identity, used by the loader row. */
export const name = "dsh-opencode-eyes-nvidia";
/** Nothing is registered here directly; the MCP client owns the tools. */
export const inject = [];

const ROOT = dirname(fileURLToPath(import.meta.url));
/** The `serverName` the tools are namespaced under: `mcp__<serverName>__<tool>`. */
const SERVER_NAME = "opencode_eyes_nvidia";
/** argv of the server itself, after the interpreter. */
const SERVER_ARGS = ["-m","opencode_eyes_nvidia"];
/** Working directory the server must be started in. */
const SERVER_CWD = join(ROOT, "src");
/** Config key and environment variable carrying the credential, if any. */
const CREDENTIAL = "NVIDIA_API_KEY";
/** Plain config → environment mappings the server reads. */
const ENV_MAP = {"model":"NVIDIA_MODEL","baseUrl":"NVIDIA_BASE_URL","timeoutSeconds":"NVIDIA_TIMEOUT","maxDimension":"NVIDIA_MAX_DIMENSION","jpegQuality":"NVIDIA_JPEG_QUALITY","thinkingMode":"NVIDIA_THINKING_MODE"};
/** The server can wait on a slow API; the harness default is 60 s. */
const DEFAULT_TOOL_TIMEOUT_MS = 300000;
/** What the harness actually spawns. */
const COMMAND = (python) => python;
/** The argv handed to `COMMAND`. */
const ARGS = (python) => [...launcherArgs(python), ...SERVER_ARGS];


/**
 * The Windows `py` launcher needs `-3` to select Python 3; a real interpreter
 * needs nothing.
 */
function launcherArgs(interpreter) {
	return /(?:^|[\\/])py(?:\.exe)?$/iu.test(interpreter) ? ["-3"] : [];
}

/** True when the path exists and is a regular file. */
async function isFile(path) {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}

async function findOnPath(names, env) {
	const raw = env.PATH ?? env.Path ?? env.path ?? "";
	for (const dir of raw.split(delimiter)) {
		if (dir.length === 0) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (await isFile(candidate)) return candidate;
		}
	}
	return undefined;
}

/**
 * Resolve an interpreter setting to an existing executable. A configured value
 * may be a path or a bare command name (`python3`, `py`), which is resolved on
 * `PATH`.
 */
async function resolveInterpreter(value, env) {
	if (!value) return undefined;
	if (await isFile(value)) return value;
	return await findOnPath([value], env);
}

/**
 * Find the Python that runs the server: the configured one, then anything on
 * `PATH` — `python`, `python3`, or the Windows `py` launcher.
 * @returns {Promise<string | undefined>} the executable, when one exists.
 */
export async function resolvePython(options = {}) {
	const env = options.env ?? process.env;
	const configured = await resolveInterpreter(options.pythonPath, env);
	if (configured !== undefined) return configured;
	return await findOnPath(
		process.platform === "win32"
			? ["python.exe", "python3.exe", "python", "py.exe", "py"]
			: ["python3", "python"],
		env,
	);
}

/**
 * Build the child environment: the caller's explicit `env` block first, then
 * every configured value, then the parent environment as a fallback for the
 * variables the harness would otherwise scrub.
 */
function buildEnv(config) {
	const env = { ...(config.env ?? {}) };
	for (const [key, variable] of Object.entries(ENV_MAP)) {
		const value = config[key] ?? process.env[variable];
		if (value !== undefined && value !== "") env[variable] = String(value);
	}
	if (CREDENTIAL !== null) {
		const value = config.apiKey ?? process.env[CREDENTIAL];
		if (value !== undefined && value !== "") env[CREDENTIAL] = String(value);
	}
	return env;
}

/**
 * Mount the MCP server.
 * @param {object} ctx - registrant context.
 * @param {object} [config] - deployment configuration.
 * @param {string} [config.python] - interpreter override.
 * @param {string} [config.apiKey] - credential for the server.
 * @param {number} [config.toolCallTimeoutMs] - per-call budget.
 * @param {Record<string, string>} [config.env] - raw environment passthrough.
 */
export async function apply(ctx, config = {}) {
	const python = await resolvePython({ env: process.env, pythonPath: config.python });
	if (python === undefined) {
		ctx.logger.warn(
			`${name}: no Python interpreter found, so ${SERVER_NAME} is not mounted. ` +
				"Set `python` in the loader row to the interpreter that has this server's dependencies.",
		);
		return;
	}

	const toolCallTimeoutMs =
		Number.isFinite(config.toolCallTimeoutMs) && config.toolCallTimeoutMs > 0
			? config.toolCallTimeoutMs
			: DEFAULT_TOOL_TIMEOUT_MS;

	await ctx.plugin(
		{
			name: `${name}-mcp`,
			inject: mcpClientInject,
			Config: McpClientConfig,
			apply: applyMcpClient,
		},
		{
			transport: "stdio",
			serverName: SERVER_NAME,
			command: typeof COMMAND === "function" ? COMMAND(python) : COMMAND,
			args: typeof ARGS === "function" ? ARGS(python) : ARGS,
			cwd: SERVER_CWD,
			env: buildEnv(config),
			toolCallTimeoutMs,
			failOnStartupError: true,
		},
	);

	ctx.logger.info(
		`${name}: mounted ${SERVER_NAME} through ${mcpClientName} (${python})`,
	);
}
