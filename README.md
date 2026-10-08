# opencode-eyes-nvidia

[![dsh.so risk](https://www.dsh.so/badge/opencode-eyes-nvidia.svg)](https://www.dsh.so/artifact/opencode-eyes-nvidia/)

**Eyes for models that cannot see — on NVIDIA NIM.** Any of seven hosted
vision models (MiniMax-M3 by default), with multi-key rotation when one key is
rate-limited.

*给不具备多模态能力的模型一双眼睛:走 NVIDIA NIM,默认 MiniMax-M3,支持多 Key 轮换。*

As a DeepSeek Harness plugin: the MCP server ships inside the bundle, so
installing one plugin is the whole setup — no `mcpServers` file to hand-edit.

## Install

**DeepSeek Harness Desktop** — open **Plugins** in the sidebar, choose **Add
plugin**, and enter:

```
https://github.com/bauerelizabeth07139/opencode-eyes-nvidia
```

Then switch the new **dsh-opencode-eyes-nvidia** bundle on. The Desktop app boots the
reserved `desktop` profile, so that is where it has to be enabled.

**dsh CLI** — install it into the profile you actually boot:

```sh
dsh plugin --profile web add bauerelizabeth07139/opencode-eyes-nvidia
```

**No git on the machine?** pnpm resolves a git shorthand with `git ls-remote`,
which fails with `'git' is not recognized` when git is missing. Use the tarball
instead — that path is plain HTTPS:

```sh
dsh plugin --profile web add https://codeload.github.com/bauerelizabeth07139/opencode-eyes-nvidia/tar.gz/main
```

The same address works in the Desktop **Add plugin** dialog. Replace `main`
with a commit SHA to pin an exact revision (`/tar.gz/<sha>`).

Uninstall with `dsh plugin --profile web remove dsh-opencode-eyes-nvidia`.

## Requirements

- **Python ≥ 3.8** on `PATH`, or pointed at with `python`.
- **Pillow** in that interpreter — the server's only third-party import
  (`pip install Pillow`).
- **At least one NVIDIA API key.** The server accepts `NVIDIA_API_KEY`,
  `NVIDIA_API_KEYS` (several, separated by spaces/commas/semicolons) or
  `NVIDIA_API_KEY_1..N`, and rotates through them on failure. `describe_image`
  needs one; `list_vision_models` works without.

## Tools

The server registers `2` tool(s). DSH namespaces them automatically,
so the model calls them as `mcp__opencode_eyes_nvidia__<tool>`:

| Tool | What it does |
|---|---|
| `describe_image` | Sends an image to the chosen NVIDIA-hosted vision model. Parameters: `image_path` (required), `prompt` (optional), `model` (optional; one of `minimaxai/minimax-m3`, `meta/llama-3.2-11b-vision-instruct`, `meta/llama-3.2-90b-vision-instruct`, `nvidia/llama-3.1-nemotron-nano-vl-8b-v1`, `google/gemma-3-27b-it`, `nvidia/nemotron-nano-12b-v2-vl`, `qwen/qwen3.5-397b-a17b`). |
| `list_vision_models` | Returns the model list, consulting the live `/models` endpoint when a key is present. |

## Configuration

| Key | Environment variable | Default | Meaning |
|---|---|---|---|
| `python` | — | discovered | interpreter that runs the server |
| `apiKey` | `NVIDIA_API_KEY` | *(empty)* | the first key of the rotation ring |
| `model` | `NVIDIA_MODEL` | `minimaxai/minimax-m3` | default model id |
| `baseUrl` | `NVIDIA_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NIM endpoint |
| `timeoutSeconds` | `NVIDIA_TIMEOUT` | `120` | the server's own HTTP timeout |
| `maxDimension` | `NVIDIA_MAX_DIMENSION` | `2048` | images are downscaled to this edge length |
| `jpegQuality` | `NVIDIA_JPEG_QUALITY` | `85` | JPEG quality of the re-encoded image |
| `thinkingMode` | `NVIDIA_THINKING_MODE` | *(unset)* | `enabled` / `disabled` / `adaptive`; only sent to `minimax` models |
| `toolCallTimeoutMs` | — | `300000` | DSH's per-call budget; key rotation sleeps between attempts |
| `env` | — | `{}` | raw passthrough — **use this for `NVIDIA_API_KEYS` and `NVIDIA_API_KEY_1..N`** |

Every field is optional and lives in the loader row. For example, in
`cordis.patch.yml`:

```yaml
- id: dsh-opencode-eyes-nvidia
  name: 'dsh-opencode-eyes-nvidia'
  config:
    apiKey: 'nvapi-...'
    model: 'minimaxai/minimax-m3'
    env:
      NVIDIA_API_KEYS: 'nvapi-first,nvapi-second'
```

## Notes

- **Rotating several keys.** `config.apiKey` sets `NVIDIA_API_KEY`; to use the
  rotation ring, pass the extra variables through `config.env`:

  ```yaml
  config:
    env:
      NVIDIA_API_KEYS: 'nvapi-first,nvapi-second'
      NVIDIA_ROTATION_BACKOFF: '2'
  ```

- **Timeouts.** A call may try several keys with a 2 s backoff between attempts,
  on top of the server's own 120 s HTTP timeout — the plugin mounts with a
  300 s budget.
- **`thinkingMode` is silently ignored** unless the model id contains
  `minimax`, which is the server's own rule.

## How it is mounted

`index.js` resolves a Python interpreter (the configured `python`, then
`python3`/`python` on `PATH`), hands the server its argv and working directory,
and mounts it as a stdio MCP server through `@deepseek-ai/dsh-mcp-client` with
`failOnStartupError: true`, so a server that cannot start is a visible error
rather than a silently missing tool.

Credentials are forwarded explicitly. The harness scrubs credential-shaped
variables (`KEY`, `TOKEN`, `SECRET`, `PASSWORD`) out of the environment a child
process inherits, so `config.apiKey` — falling back to the variable the server
documents — is written into the child's environment by the plugin itself. That
means both of these work:

```yaml
config:
  apiKey: '<your key>'
```

```sh
export NVIDIA_API_KEY='<your key>'   # picked up at load time
```

## Development

No build step and no runtime dependencies — `@deepseek-ai/cordis` and
`@deepseek-ai/dsh-mcp-client` are peers supplied by the Harness.

```sh
npm test    # node >= 22: manifest checks + the stdio mount, both Harness-free
```

The mount test loads `index.js` with `@deepseek-ai/dsh-mcp-client` stubbed and
asserts the exact stdio configuration the plugin produces, including the
credential forwarding above.

## Repository layout

| Path | Purpose |
|---|---|
| `index.js` | the DSH plugin: resolves the interpreter and mounts the server |
| `cordis.patch.yml` | the loader row that activates the plugin |
| `locale/{en,zh}.json` | card title and description for the plugin lists |
| `assets/icon.svg` | card artwork |
| `test/` | `npm test`: manifest composition and the mount contract |
| `src/opencode_eyes_nvidia/` | the MCP server, unchanged |
| `pyproject.toml`, `requirements.txt` | the Python package metadata, unchanged |

## Other hosts (unchanged)

The server is a plain stdio MCP server and still works anywhere else. The
repository's original README is kept verbatim as
[`README.opencode.md`](README.opencode.md), and the launch stanza from it keeps
working:

```json
{
  "mcp": {
    "opencode-eyes-nvidia": {
      "type": "local",
      "command": ["python", "-m", "opencode_eyes_nvidia"],
      "enabled": true,
      "timeout": 120000,
      "environment": {
        "NVIDIA_API_KEYS": "{env:NVIDIA_API_KEYS}",
        "NVIDIA_API_KEY": "{env:NVIDIA_API_KEY}"
      }
    }
  }
}
```

On another host, run the server from the repository's `src` directory (or put
`src` on `PYTHONPATH`).

## License

[MIT](LICENSE) — the repository declared MIT in `pyproject.toml` but shipped no licence file; this plugin's release adds one.
