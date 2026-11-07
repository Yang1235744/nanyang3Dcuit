#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""南阳 3Dcuit · 图片转 3D 角色管线

输入一张单人物图片（正面 / 侧面都可），输出可进引擎的 .glb。

说明：本机显卡不够跑 3D 重建模型，所以这里**不加载本地权重**，只把请求转到
托管推理服务。三种后端：

1) gradio —— 调用 Hugging Face Space 的 Gradio API（需 pip install gradio_client）
2) rest   —— POST 到自建 / 第三方 HTTP 接口，接口返回 glb 二进制或 {"url": "..."}
3) none   —— 只做参数检查，打印可用的服务清单，不联网

先看某个 Space 有哪些接口：
    python img23d.py --list-apis --space tencent/Hunyuan3D-2

再跑转换：
    python img23d.py --image hero_front.png --out hero.glb \
        --provider gradio --space tencent/Hunyuan3D-2 --api-name /generation_all

或者自建接口：
    python img23d.py --image hero.png --out hero.glb \
        --provider rest --url http://127.0.0.1:8000/reconstruct --field image
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path
from urllib import error, request

MODEL_SUFFIXES = {".glb", ".gltf", ".obj", ".ply", ".stl", ".zip"}
DEFAULT_SPACES = (
    "tencent/Hunyuan3D-2",
    "stabilityai/TripoSR",
)


def log(msg: str) -> None:
    print(msg)


def list_apis(space: str) -> int:
    try:
        from gradio_client import Client
    except ImportError:
        log("缺少 gradio_client，请先执行：pip install gradio_client")
        return 1
    client = Client(space)
    client.view_api()
    return 0


def collect_files(value, found: list[Path]) -> None:
    """Gradio 返回结构可能是 path / tuple / dict，递归捞出模型文件。"""
    if isinstance(value, str):
        suffix = Path(value).suffix.lower()
        if suffix in MODEL_SUFFIXES and Path(value).exists():
            found.append(Path(value))
    elif isinstance(value, (list, tuple)):
        for item in value:
            collect_files(item, found)
    elif isinstance(value, dict):
        for item in value.values():
            collect_files(item, found)


def run_gradio(image: Path, out: Path, space: str, api_name: str) -> int:
    try:
        from gradio_client import Client, handle_file
    except ImportError:
        log("缺少 gradio_client，请先执行：pip install gradio_client")
        return 1

    log(f"[3D] 连接 Space：{space}")
    client = Client(space)
    try:
        if api_name:
            result = client.predict(handle_file(str(image)), api_name=api_name)
        else:
            # 不指定接口名时，让 gradio_client 用默认接口
            result = client.predict(handle_file(str(image)))
    except Exception as exc:  # noqa: BLE001 - 远端服务错误种类多，统一提示
        log(f"[失败] 调用 Space 出错：{exc}")
        log("提示：先运行 --list-apis 确认接口名和参数顺序，或换一个 Space。")
        return 1

    found: list[Path] = []
    collect_files(result, found)
    if not found:
        log(f"[失败] 服务返回了结果，但没找到模型文件：{result!r}")
        return 1

    src = next((p for p in found if p.suffix.lower() in {".glb", ".gltf"}), found[0])
    out.parent.mkdir(parents=True, exist_ok=True)
    if src.suffix.lower() == out.suffix.lower():
        shutil.copyfile(src, out)
    else:
        # 导出格式和服务不一致时保留原文件，避免破坏内容
        target = out.with_suffix(src.suffix)
        shutil.copyfile(src, target)
        log(f"[提示] 服务只提供 {src.suffix}，已保存为 {target}")
        out = target
    log(f"[完成] 3D 模型已保存：{out}")
    return 0


def _encode_multipart(field: str, filename: str, payload: bytes) -> tuple[bytes, str]:
    boundary = "----nanyang3dcuit" + uuid.uuid4().hex
    body = bytearray()
    body += f"--{boundary}\r\n".encode()
    body += f'Content-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'.encode()
    body += b"Content-Type: application/octet-stream\r\n\r\n"
    body += payload + b"\r\n"
    body += f"--{boundary}--\r\n".encode()
    return bytes(body), f"multipart/form-data; boundary={boundary}"


def run_rest(image: Path, out: Path, url: str, field: str, api_key: str, timeout: int) -> int:
    payload = image.read_bytes()
    body, content_type = _encode_multipart(field, image.name, payload)
    headers = {"Content-Type": content_type}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    log(f"[3D] POST {url}")
    req = request.Request(url, data=body, headers=headers, method="POST")
    try:
        with request.urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "")
            raw = resp.read()
    except error.HTTPError as exc:
        detail = exc.read()[:200].decode("utf-8", "ignore")
        log(f"[失败] HTTP {exc.code}：{detail}")
        return 1
    except Exception as exc:  # noqa: BLE001 - 网络错误统一提示
        log(f"[失败] 请求失败：{exc}")
        return 1

    out.parent.mkdir(parents=True, exist_ok=True)
    if "json" in content_type:
        try:
            data = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            log("[失败] 接口返回的不是合法 JSON")
            return 1
        link = data.get("url") or data.get("model_url") or data.get("glb")
        if not link:
            log(f"[失败] JSON 里找不到 url / model_url / glb：{data}")
            return 1
        log(f"[3D] 下载模型：{link}")
        try:
            with request.urlopen(link, timeout=timeout) as resp:
                raw = resp.read()
        except Exception as exc:  # noqa: BLE001
            log(f"[失败] 下载模型失败：{exc}")
            return 1

    out.write_bytes(raw)
    log(f"[完成] 3D 模型已保存：{out}（{len(raw) / 1024:.1f} KB）")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="单图 -> 3D 角色（.glb），不在本机加载模型权重")
    parser.add_argument("--image", help="输入人物图片")
    parser.add_argument("--out", help="输出模型路径，建议 .glb")
    parser.add_argument("--provider", choices=("gradio", "rest", "none"), default="gradio")
    parser.add_argument("--space", default=DEFAULT_SPACES[0], help="Gradio Space，如 tencent/Hunyuan3D-2")
    parser.add_argument("--api-name", default="", help="Gradio 接口名，如 /generation_all；留空用默认接口")
    parser.add_argument("--url", help="rest 后端地址")
    parser.add_argument("--field", default="image", help="rest 上传字段名，默认 image")
    parser.add_argument("--api-key", default="", help="rest 后端鉴权 Key，可选")
    parser.add_argument("--timeout", type=int, default=300, help="网络超时秒数，默认 300")
    parser.add_argument("--list-apis", action="store_true", help="只列出 Space 接口")
    args = parser.parse_args()

    if args.list_apis:
        return list_apis(args.space)

    if args.provider == "none":
        log("当前未指定 3D 后端。本机不跑权重，可用方案：")
        for space in DEFAULT_SPACES:
            log(f"  - Gradio Space：{space}（--provider gradio --space {space}）")
        log("  - 自建接口：--provider rest --url <你的地址>")
        return 0

    if not args.image or not args.out:
        parser.error("--image 和 --out 必填")

    image = Path(args.image)
    if not image.exists():
        log(f"[失败] 找不到图片：{image}")
        return 1
    out = Path(args.out)

    if args.provider == "gradio":
        return run_gradio(image, out, args.space, args.api_name)
    if not args.url:
        parser.error("--provider rest 时必须提供 --url")
    return run_rest(image, out, args.url, args.field, args.api_key, args.timeout)


if __name__ == "__main__":
    sys.exit(main())
