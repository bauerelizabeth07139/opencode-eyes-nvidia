import base64
import io
import json
import logging
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s", stream=sys.stderr)
logger = logging.getLogger("opencode-eyes-nvidia")

try:
    from PIL import Image as PILImage
except ImportError:
    logger.error("Pillow is required. Install with: pip install Pillow")
    sys.exit(1)

NVIDIA_API_BASE = os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1")
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "")
NVIDIA_MODEL = os.environ.get("NVIDIA_MODEL", "minimaxai/minimax-m3")
NVIDIA_TIMEOUT = int(os.environ.get("NVIDIA_TIMEOUT", "120"))
NVIDIA_MAX_DIMENSION = int(os.environ.get("NVIDIA_MAX_DIMENSION", "2048"))
NVIDIA_JPEG_QUALITY = int(os.environ.get("NVIDIA_JPEG_QUALITY", "85"))
NVIDIA_THINKING_MODE = os.environ.get("NVIDIA_THINKING_MODE", "").strip().lower()

# Multimodal (vision) models exposed through the NVIDIA NIM hosted API.
VISION_MODELS = {
    "minimaxai/minimax-m3": {
        "description": "MiniMax-M3 multimodal MoE VLM (text/image/video -> text), 1M context, reasoning-capable",
        "context": 1000000,
        "default": True,
    },
    "meta/llama-3.2-11b-vision-instruct": {
        "description": "Meta Llama 3.2 11B Vision Instruct (image + text)",
        "context": 128000,
        "default": False,
    },
    "meta/llama-3.2-90b-vision-instruct": {
        "description": "Meta Llama 3.2 90B Vision Instruct (image + text)",
        "context": 128000,
        "default": False,
    },
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": {
        "description": "NVIDIA Nemotron Nano VL 8B (image + text)",
        "context": 128000,
        "default": False,
    },
    "google/gemma-3-27b-it": {
        "description": "Google Gemma 3 27B IT (image + text)",
        "context": 128000,
        "default": False,
    },
    "nvidia/nemotron-nano-12b-v2-vl": {
        "description": "NVIDIA Nemotron Nano 12B v2 VL (image/video + text)",
        "context": 128000,
        "default": False,
    },
    "qwen/qwen3.5-397b-a17b": {
        "description": "Qwen 3.5 397B A17B VLM (image/video + text)",
        "context": 262000,
        "default": False,
    },
}

_TOOLS = [
    {
        "name": "describe_image",
        "description": (
            "描述一张图片的内容。默认使用 NVIDIA NIM 托管的 MiniMax-M3 多模态大模型对输入图片进行理解，"
            "返回详细的图片文字描述。为不具备多模态能力的模型提供'眼睛'。"
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "image_path": {
                    "type": "string",
                    "description": "图片文件的绝对或相对路径（例如 C:/Users/name/photo.jpg 或 /home/user/photo.jpg）",
                },
                "prompt": {
                    "type": "string",
                    "description": "可选的自定义提示词，用于引导图片描述（默认为中文详细描述请求）",
                    "default": "请详细描述这张图片的内容，包括主要物体、场景、颜色、人物活动等。",
                },
                "model": {
                    "type": "string",
                    "enum": list(VISION_MODELS.keys()),
                    "description": "可选的多模态模型，默认 minimaxai/minimax-m3",
                    "default": NVIDIA_MODEL,
                },
            },
            "required": ["image_path"],
        },
    },
    {
        "name": "list_vision_models",
        "description": "列出 NVIDIA NIM API 上可用的多模态（视觉）模型及其元数据。",
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def _encode_image(image_path: str) -> str:
    """Load an image, downscale to a sane size, and compress to a JPEG base64 string.

    Shrinking the payload dramatically reduces upload + inference latency, which
    keeps the request well under the MCP client timeout (default 5000 ms).
    """
    path = Path(image_path)
    if not path.is_file():
        raise FileNotFoundError(f"Image file not found: {image_path}")

    img = PILImage.open(str(path))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGB")

    if NVIDIA_MAX_DIMENSION > 0:
        img.thumbnail((NVIDIA_MAX_DIMENSION, NVIDIA_MAX_DIMENSION), PILImage.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=NVIDIA_JPEG_QUALITY, optimize=True)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def _extract_text(message: dict) -> str:
    """Return assistant text, falling back to reasoning fields when content is empty.

    MiniMax-M3 is a reasoning model and may return the answer in
    `reasoning_content`/`reasoning` with an empty `content`.
    """
    content = message.get("content")
    if isinstance(content, str) and content.strip():
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get("type") == "text" and item.get("text"):
                parts.append(item["text"])
        if parts:
            return "\n".join(parts)
    for key in ("reasoning_content", "reasoning", "reasoning_text"):
        value = message.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return ""


def _call_nvidia_api(image_b64: str, prompt: str, model: str) -> str:
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{image_b64}"},
                    },
                ],
            }
        ],
        "max_tokens": 2048,
        "stream": False,
    }
    if NVIDIA_THINKING_MODE in ("enabled", "disabled", "adaptive") and "minimax" in model:
        payload["thinking_mode"] = NVIDIA_THINKING_MODE

    body = json.dumps(payload).encode("utf-8")
    url = NVIDIA_API_BASE.rstrip("/") + "/chat/completions"

    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=NVIDIA_TIMEOUT) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        error_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"NVIDIA API HTTP {exc.code}: {error_body}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"NVIDIA API connection error: {exc.reason}") from exc

    result = json.loads(raw)
    choices = result.get("choices", [])
    if not choices:
        raise RuntimeError(f"No choices in API response: {result}")

    text = _extract_text(choices[0].get("message", {}))
    if not text:
        raise RuntimeError(f"Empty response from {model}: {result}")
    return text


def _fetch_live_models() -> list:
    """Best-effort query of the models the key can access via /v1/models."""
    url = NVIDIA_API_BASE.rstrip("/") + "/models"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {NVIDIA_API_KEY}",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=NVIDIA_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"Could not query live model list: {exc}") from exc

    ids = [m.get("id") for m in data.get("data", []) if m.get("id")]
    return ids


def _send(message: dict):
    data = json.dumps(message, ensure_ascii=False) + "\n"
    sys.stdout.buffer.write(data.encode("utf-8"))
    sys.stdout.buffer.flush()


def _handle_request(message: dict) -> dict:
    method = message.get("method", "")
    req_id = message.get("id")
    params = message.get("params", {})

    response = {"jsonrpc": "2.0"}
    if req_id is not None:
        response["id"] = req_id

    try:
        if method == "ping":
            response["result"] = {}
        elif method == "initialize":
            response["result"] = {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "opencode-eyes-nvidia", "version": "1.0.0"},
            }
        elif method == "tools/list":
            response["result"] = {"tools": _TOOLS}
        elif method == "tools/call":
            tool_name = params.get("name", "")
            arguments = params.get("arguments", {})

            if tool_name == "list_vision_models":
                lines = ["可用多模态（视觉）模型（NVIDIA NIM API）:"]
                for mid, meta in VISION_MODELS.items():
                    tag = "（默认）" if meta.get("default") else ""
                    ctx = meta.get("context")
                    ctx_str = f"{ctx:,}" if ctx else "N/A"
                    lines.append(f"- {mid}{tag}: {meta['description']} (context: {ctx_str})")
                if NVIDIA_API_KEY:
                    try:
                        live = _fetch_live_models()
                        lines.append("")
                        lines.append("当前 API Key 可访问的模型: " + ", ".join(live))
                    except Exception as exc:
                        lines.append("")
                        lines.append(f"（无法实时查询 /v1/models: {exc}）")
                response["result"] = {
                    "content": [{"type": "text", "text": "\n".join(lines)}]
                }
            elif tool_name == "describe_image":
                image_path = arguments.get("image_path", "")
                prompt = arguments.get("prompt", "请详细描述这张图片的内容，包括主要物体、场景、颜色、人物活动等。")
                model = arguments.get("model") or NVIDIA_MODEL

                if not image_path:
                    raise ValueError("image_path is required")
                if not NVIDIA_API_KEY:
                    raise RuntimeError("NVIDIA_API_KEY environment variable is not set")

                if model not in VISION_MODELS:
                    raise ValueError(
                        f"Unknown vision model '{model}'. Use one of: {', '.join(VISION_MODELS.keys())}"
                    )

                image_b64 = _encode_image(image_path)
                description = _call_nvidia_api(image_b64, prompt, model)

                response["result"] = {
                    "content": [
                        {"type": "text", "text": f"[opencode-eyes-nvidia] 图片描述 ({model}):\n{description}"}
                    ],
                }
            else:
                raise ValueError(f"Unknown tool: {tool_name}")
        else:
            response["error"] = {"code": -32601, "message": f"Method not found: {method}"}
    except Exception as exc:
        logger.error("Error handling %s: %s", method, exc, exc_info=True)
        response["error"] = {"code": -32603, "message": str(exc)}

    return response


def main():
    if not NVIDIA_API_KEY:
        logger.warning("NVIDIA_API_KEY is not set. Set it via environment variable.")
    logger.info("opencode-eyes-nvidia server starting (model=%s, base=%s)", NVIDIA_MODEL, NVIDIA_API_BASE)

    for raw_line in sys.stdin.buffer:
        line_str = raw_line.decode("utf-8", errors="replace").strip()
        if not line_str:
            continue

        try:
            message = json.loads(line_str)
        except json.JSONDecodeError as exc:
            logger.warning("Invalid JSON: %s", exc)
            continue

        if message.get("method") == "notifications/initialized":
            logger.info("Client initialized")
            continue

        _send(_handle_request(message))


if __name__ == "__main__":
    main()