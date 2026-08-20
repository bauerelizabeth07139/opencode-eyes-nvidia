# opencode-eyes-nvidia 👁️

MCP server that provides image description capability using NVIDIA NIM hosted API
(`https://integrate.api.nvidia.com/v1`) with the **MiniMax-M3** multimodal model.

为不具备多模态能力的模型提供**"眼睛"**。将图片输入，即可获得详细的图片文字描述。

## 功能

| 工具 | 说明 |
|------|------|
| `describe_image` | 描述一张图片的内容，默认使用 MiniMax-M3 多模态大模型 |
| `list_vision_models` | 列出 NVIDIA NIM API 上可用的多模态（视觉）模型 |

## 多模态模型

默认模型为 `minimaxai/minimax-m3`（文本/图像/视频输入 → 文本输出，1M 上下文，支持推理）。
可通过 `NVIDIA_MODEL` 或 `describe_image` 的 `model` 参数切换：

| 模型 ID | 说明 |
|---------|------|
| `minimaxai/minimax-m3` | MiniMax-M3 多模态 MoE VLM（默认，支持图像/视频） |
| `meta/llama-3.2-11b-vision-instruct` | Meta Llama 3.2 11B Vision |
| `meta/llama-3.2-90b-vision-instruct` | Meta Llama 3.2 90B Vision |
| `nvidia/llama-3.1-nemotron-nano-vl-8b-v1` | NVIDIA Nemotron Nano VL 8B |
| `google/gemma-3-27b-it` | Google Gemma 3 27B IT |
| `nvidia/nemotron-nano-12b-v2-vl` | NVIDIA Nemotron Nano 12B v2 VL |
| `qwen/qwen3.5-397b-a17b` | Qwen 3.5 397B A17B VLM |

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `NVIDIA_API_KEY` | 否* | — | 单个 NVIDIA API Key（在 https://build.nvidia.com 获取，`nvapi-...`） |
| `NVIDIA_API_KEYS` | 否* | — | 多个 Key，用逗号 / 分号 / 空格 / 换行分隔 |
| `NVIDIA_API_KEY_1` … `NVIDIA_API_KEY_N` | 否* | — | 编号 Key，`NVIDIA_API_KEY_1` 起依次读取 |
| `NVIDIA_BASE_URL` | 否 | `https://integrate.api.nvidia.com/v1` | API 基础地址 |
| `NVIDIA_MODEL` | 否 | `minimaxai/minimax-m3` | 默认使用的多模态模型 |
| `NVIDIA_TIMEOUT` | 否 | `120` | API 请求超时（秒） |
| `NVIDIA_MAX_DIMENSION` | 否 | `2048` | 发送前图片最长边缩放到该像素，0 表示不缩放 |
| `NVIDIA_JPEG_QUALITY` | 否 | `85` | 发送前 JPEG 压缩质量（0-100） |
| `NVIDIA_THINKING_MODE` | 否 | （空） | MiniMax-M3 推理模式：`enabled` / `disabled` / `adaptive` |
| `NVIDIA_ROTATION_MAX_RETRIES` | 否 | Key 数量 | 轮询总尝试次数（跨所有 Key） |
| `NVIDIA_ROTATION_BACKOFF` | 否 | `2` | 每次失败后等待的秒数（等待配额刷新） |

\* 至少需要配置一个 Key：`NVIDIA_API_KEY`、`NVIDIA_API_KEYS` 或 `NVIDIA_API_KEY_1..N` 任一即可，可同时配置（去重合并）。

## Key 轮询（多 Key 自动切换）

支持配置多个 API Key：请求按顺序使用，遇错自动切换到下一个 Key，**不会删除原 Key**，
只是把它排到队列末尾，等待其配额刷新后再用。全程自动重试，无需人工干预。

工作方式：

1. 启动时把所有 Key 合并进一个队列（去重，按 `NVIDIA_API_KEY` → `NVIDIA_API_KEYS` → `NVIDIA_API_KEY_1..N` 顺序）。
2. 请求默认使用队首 Key。
3. 遇到可重试错误（HTTP `401 / 403 / 404 / 408 / 429 / 5xx`，或连接超时）时：
   队首 Key 移到队尾，等待 `NVIDIA_ROTATION_BACKOFF` 秒后改用下一个 Key 重试。
4. 所有 Key 都被轮过之后（共 `NVIDIA_ROTATION_MAX_RETRIES` 次尝试）仍未成功，才抛出最后一个错误。
5. 队列状态在多次调用间保留——被限流的 Key 会排在后面，等下次轮到时配额往往已刷新。

示例：

```bash
# 方式一：逗号分隔多个 Key
set NVIDIA_API_KEYS=nvapi-key-1,nvapi-key-2,nvapi-key-3

# 方式二：编号 Key
set NVIDIA_API_KEY_1=nvapi-key-1
set NVIDIA_API_KEY_2=nvapi-key-2

# 方式三：单个 Key（向后兼容）
set NVIDIA_API_KEY=nvapi-key-1
```

在 OpenCode 配置中把环境变量传给 MCP 服务：

```json
{
  "mcp": {
    "opencode-eyes-nvidia": {
      "type": "local",
      "command": ["python", "-m", "opencode_eyes_nvidia"],
      "enabled": true,
      "timeout": 120000,
      "environment": {
        "NVIDIA_API_KEYS": "{env:NVIDIA_API_KEYS}"
      }
    }
  }
}
```

## 安装

```bash
pip install -r requirements.txt
```

或安装为包：

```bash
pip install .
```

## 运行

```bash
# 设置环境变量（Windows，至少一种）
set NVIDIA_API_KEY=nvapi-你的key
# 或 set NVIDIA_API_KEYS=nvapi-key-1,nvapi-key-2

# 启动服务
python -m opencode_eyes_nvidia
```

## 在 OpenCode 中配置

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

## 手动测试

不启动 opencode，直接通过 stdio 验证：

```powershell
$env:NVIDIA_API_KEY = "nvapi-xxx"
python -m opencode_eyes_nvidia
```

然后在另一终端发送 MCP JSON-RPC 消息，例如：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"describe_image","arguments":{"image_path":"C:/path/to/photo.jpg"}}}
```

## 与 opencode-eyes 的区别

- API 从 StepFun 换成 **NVIDIA NIM**（`https://integrate.api.nvidia.com/v1`）
- 默认模型从 `step-3.7-flash` 换成 **MiniMax-M3**（`minimaxai/minimax-m3`）
- 新增 `list_vision_models` 工具与多模型切换能力
- 支持 MiniMax-M3 的 `thinking_mode` 推理控制
- 支持**多 API Key 轮询**：遇错自动切换下一个 Key，原 Key 排到队尾等待配额刷新

## License

MIT