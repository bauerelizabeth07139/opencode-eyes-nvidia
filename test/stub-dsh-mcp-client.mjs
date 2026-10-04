/**
 * Stand-in for `@deepseek-ai/dsh-mcp-client` used by `hooks.mjs`.
 *
 * The plugin mounts the server by handing this package's `apply` to
 * `ctx.plugin`. Keeping the identities stable lets a test assert what was
 * mounted, and with which stdio configuration, without a running Harness.
 */

export const name = "@deepseek-ai/dsh-mcp-client";
export const inject = ["tools", "systemPrompt"];
export const Config = { __stub: "mcp-client-config" };

/** The real `apply` opens the transport; the stub only marks the call. */
export const apply = function apply() {};
