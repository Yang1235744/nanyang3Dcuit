r"""nanyang3Dcuit 桌面版 —— 本地壳 + 云端 API 对话。

设计原则：
  * 本机不加载任何大模型权重，所有推理都走 OpenAI 兼容的云端接口；
  * 纯 PySide6 实现，不引入重型第三方 UI / Markdown 依赖；
  * 会话与配置落盘到 %APPDATA%\Nanyang3Dcuit，程序本体可完全离线启动。

命令行：
  python app.py              正常启动
  python app.py --selftest   无界面自检（配合 QT_QPA_PLATFORM=offscreen）
"""

import os
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
os.environ.setdefault("QT_API", "pyside6")
os.environ.setdefault("QT_LOGGING_RULES", "qt.qpa.*=false")

import sys
import json
import re
import uuid
import html
import webbrowser
import subprocess
import datetime
import threading
import requests
from requests import exceptions as rex

from PySide6.QtCore import Qt, QThread, Signal, QTimer
from PySide6.QtGui import QIcon, QPixmap, QPainter, QColor, QFont, QPalette, QFontMetrics
from PySide6.QtWidgets import (
    QApplication, QWidget, QMainWindow, QFrame, QLabel, QPushButton, QVBoxLayout,
    QHBoxLayout, QPlainTextEdit, QScrollArea, QListWidget, QListWidgetItem,
    QDialog, QLineEdit, QComboBox, QFormLayout, QMessageBox, QTextBrowser,
    QMenu,
)

# ---------------------------------------------------------------- 常量

APP_NAME = "Nanyang3Dcuit"
WEB_URL = "https://yang1235744.github.io/nanyang3Dcuit/"
REPO_URL = "https://github.com/Yang1235744/nanyang3dCuit"
TIMEOUT = 120  # 秒，流式对话整体超时

# 供应商预设：base_url + 默认模型 + 备选模型（仅作提示，用户可随便改）
PROVIDERS = {
    "DeepSeek": {
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "hint": "常用：deepseek-chat；推理更强可填 deepseek-reasoner",
    },
    "Kimi 月之暗面": {
        "base_url": "https://api.moonshot.cn/v1",
        "model": "kimi-k2-0905-preview",
        "hint": "模型名可改，例如 kimi-k2-0905-preview",
    },
    "OpenAI": {
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4o-mini",
        "hint": "常用：gpt-4o-mini / gpt-4o",
    },
    "自定义": {
        "base_url": "",
        "model": "",
        "hint": "任何 OpenAI 兼容服务，例如 http://127.0.0.1:8000/v1",
    },
}

SYSTEM_PROMPT = (
    "你是 nanyang3Dcuit（南阳三维角色工坊）的桌面助手。项目主站："
    + WEB_URL
    + "。你的职责：用简体中文、简短直给地回答 2D 游戏美术与 RPG Maker 素材相关问题。"
    "本项目把人物图片做成 RPG Maker 行走图，或转成 3D 角色（.glb）。"
    "本机不加载任何大模型权重，也不具备直接生成图片或 3D 模型的能力。"
    "当用户要求出图 / 做行走图 / 转 3D 时，不要假装能直接生成，而应："
    "1) 提示他打开网页版（顶部菜单「网页版」）或访问上面的链接；"
    "2) 或给出本地 pipeline 命令示例，例如：\n"
    "   python pipeline/sprite2d.py --front assets/samples/hero_front.jpg "
    "--back assets/samples/hero_back.jpg --side assets/samples/hero_side.jpg "
    "--out out/hero_walk.png\n"
    "   python pipeline/img23d.py --image assets/samples/hero_front.jpg --out out/hero.glb "
    "--provider gradio --space tencent/Hunyuan3D-2 --api-name /generation_all\n"
    "回答控制在 5 段以内，能用列表就用列表，不要写客套话。"
)

DEFAULT_CONFIG = {
    "provider": "DeepSeek",
    "base_url": PROVIDERS["DeepSeek"]["base_url"],
    "model": PROVIDERS["DeepSeek"]["model"],
    "api_key": "",
}

# ---------------------------------------------------------------- 路径

APP_DIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), APP_NAME)
CONFIG_PATH = os.path.join(APP_DIR, "config.json")
SESSIONS_PATH = os.path.join(APP_DIR, "sessions.json")
# exe 运行时 __file__ 在临时解包目录，用 sys.executable 定位项目根才可靠
if getattr(sys, "frozen", False):
    PROJECT_ROOT = os.path.dirname(os.path.abspath(sys.executable))
else:
    PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def ensure_dir(path):
    """确保目录存在，失败返回 False（不抛异常，调用方自己提示）。"""
    try:
        os.makedirs(path, exist_ok=True)
        return True
    except OSError:
        return False


def load_json(path, fallback):
    """读 JSON，损坏或缺失都退回默认值。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, type(fallback)) else fallback
    except (OSError, ValueError):
        return fallback


def save_json(path, data):
    """原子写 JSON；失败返回 False 而不是崩掉界面。"""
    if not ensure_dir(os.path.dirname(path)):
        return False
    tmp = path + ".tmp"
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
        return True
    except OSError:
        return False


def load_config():
    cfg = DEFAULT_CONFIG.copy()
    data = load_json(CONFIG_PATH, {})
    if isinstance(data, dict):
        for k in DEFAULT_CONFIG:
            if isinstance(data.get(k), str):
                cfg[k] = data[k]
    return cfg


def save_config(cfg):
    return save_json(CONFIG_PATH, cfg)


def now_str():
    return datetime.datetime.now().strftime("%Y-%m-%d %H:%M")


def open_path(path):
    """用系统默认方式打开文件 / 目录 / URL。"""
    try:
        if os.name == "nt":
            os.startfile(path)  # noqa: 仅 Windows
        else:
            subprocess.Popen(["xdg-open", path])
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- Markdown 子集

CODE_BLOCK_RE = re.compile(r"```([A-Za-z0-9_+-]*)\r?\n(.*?)```", re.S)
BULLET_RE = re.compile(r"^\s*[-*+]\s+(.*)$")
ORDERED_RE = re.compile(r"^\s*(\d+)[.、)]\s+(.*)$")
HEADING_RE = re.compile(r"^(\#{1,6})\s+(.*)$")


def _inline_md(text):
    """行内：先转义，再处理 **粗体**、`代码`、*斜体* 与 [文字](链接)。"""
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`\n]+)`", r'<code class="ink">\1</code>', text)
    text = re.sub(r"\*\*([^*\n]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"(?<![\w*])\*([^*\n]+)\*(?![\w*])", r"<i>\1</i>", text)
    text = re.sub(r"\[([^\]\n]+)\]\((https?://[^)\s]+)\)", r'<a href="\2">\1</a>', text)
    return text


def _wrap_code(body, limit=76):
    """气泡里没有横向滚动条，长代码行在这里按字符硬折行，避免被裁掉。"""
    lines = []
    for line in body.split("\n"):
        while len(line) > limit:
            lines.append(line[:limit])
            line = "  " + line[limit:]
        lines.append(line)
    return "\n".join(lines)


def md_to_html(text):
    """把少量 Markdown 转成 QTextBrowser 能吃下的 HTML。

    只支持：代码块、# 标题（1~3 级）、有序 / 无序列表、分隔线、行内粗体与代码。
    流式输出时结尾可能不完整，这里对截断的代码块做兜底闭合。
    """
    blocks = []

    def take_code(m):
        lang = m.group(1).strip()
        body = _wrap_code(m.group(2).replace("\r\n", "\n").rstrip("\n"))
        label = '<div class="lang">%s</div>' % html.escape(lang) if lang else ""
        blocks.append(label + '<pre class="code">' + html.escape(body) + "</pre>")
        return "\x00%d\x00" % (len(blocks) - 1)

    text = CODE_BLOCK_RE.sub(take_code, text)
    # 未闭合的代码块：逐字显示，避免整段消失
    m = re.search(r"```[A-Za-z0-9_+-]*\r?\n(.*)$", text, re.S)
    if m:
        text = text[: m.start()] + "\x00%d\x00" % len(blocks)
        blocks.append('<pre class="code">' + html.escape(_wrap_code(m.group(1))) + "</pre>")

    out, close_ul, close_ol = [], False, False

    def close_lists():
        nonlocal close_ul, close_ol
        if close_ul:
            out.append("</ul>")
            close_ul = False
        if close_ol:
            out.append("</ol>")
            close_ol = False

    for raw in text.split("\n"):
        line = raw.rstrip()
        if not line.strip():
            close_lists()
            continue
        if line.strip().startswith("\x00"):
            close_lists()
            out.append(line.strip())
            continue
        hm = HEADING_RE.match(line)
        if hm:
            close_lists()
            level = min(len(hm.group(1)), 3)
            out.append("<h%d>%s</h%d>" % (level, _inline_md(hm.group(2)), level))
            continue
        if re.match(r"^\s*(---|\*\*\*)\s*$", line):
            close_lists()
            out.append("<hr/>")
            continue
        bm = BULLET_RE.match(line)
        if bm:
            if close_ol:
                out.append("</ol>")
                close_ol = False
            if not close_ul:
                out.append('<ul class="md">')
                close_ul = True
            out.append("<li>%s</li>" % _inline_md(bm.group(1)))
            continue
        om = ORDERED_RE.match(line)
        if om:
            if close_ul:
                out.append("</ul>")
                close_ul = False
            if not close_ol:
                out.append('<ol class="md">')
                close_ol = True
            out.append("<li>%s</li>" % _inline_md(om.group(2)))
            continue
        close_lists()
        out.append("<p>%s</p>" % _inline_md(line))

    close_lists()
    body = "\n".join(out)
    body = re.sub(r"\x00(\d+)\x00", lambda m: blocks[int(m.group(1))], body)
    return body


# ---------------------------------------------------------------- 深蓝主题 QSS

QSS = """
* { outline: none; }
/* 只给顶层和具体容器设底色，避免 QLabel 等子控件被刷成不透明色块 */
QWidget { color: #cfd8ea;
          font-family: "Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI", sans-serif;
          font-size: 13px; }
QMainWindow, QDialog { background: #0b1120; }
QLabel { background: transparent; }

#Sidebar { background: #0e1626; border-right: 1px solid #1b2740; }
#BrandMark { background: #35d6f5; color: #061225; border-radius: 10px;
             font-size: 18px; font-weight: 700; }
#BrandTitle { color: #e8f1ff; font-size: 15px; font-weight: 700; }
#BrandSub { color: #64748b; font-size: 11px; }

#NewChat { background: #14243d; border: 1px solid #24365a; border-radius: 10px;
           padding: 9px 12px; color: #dce8ff; text-align: left; }
#NewChat:hover { background: #1a3050; border-color: #35d6f5; }

#SessionList { background: transparent; border: none; }
#SessionList::item { padding: 9px 10px; border-radius: 8px; color: #9fb0cb; }
#SessionList::item:hover { background: #16233b; color: #e3edff; }
#SessionList::item:selected { background: #1b2c4a; color: #ffffff;
                              border-left: 3px solid #35d6f5; }

#SettingsBtn { background: transparent; border: 1px solid #1e2b44; border-radius: 10px;
               padding: 9px 12px; color: #9fb0cb; text-align: left; }
#SettingsBtn:hover { background: #16233b; color: #e3edff; border-color: #6d3bff; }

#TopBar { background: #101828; border-bottom: 1px solid #1b2740; }
#ModelName { color: #e8f1ff; font-size: 14px; font-weight: 600; }
#StatusText { color: #64748b; font-size: 12px; }
#Dot { font-size: 14px; color: #35d6f5; }
#ToolBtn { background: #131f36; border: 1px solid #22314f; border-radius: 8px;
           padding: 6px 12px; color: #a9bcd9; }
#ToolBtn:hover { background: #1a2a47; border-color: #35d6f5; color: #ffffff; }

#Scroll { background: #0b1120; border: none; }
#Scroll > QWidget > QWidget { background: #0b1120; }
#MsgCol { background: #0b1120; }

#Row { background: transparent; }
#UserBubble { background: #1d3757; border: 1px solid #2b4f7d; border-radius: 12px;
              padding: 2px; }
#UserText { background: transparent; color: #eaf3ff; }
#BotBubble { background: #101828; border: 1px solid #1e2b44; border-radius: 12px;
             padding: 2px; }
#BotText { background: #101828; color: #d7e2f5; border: none; }
#Role { color: #64748b; font-size: 11px; }

#Composer { background: #101828; border-top: 1px solid #1b2740; }
#Input { background: #0d1626; border: 1px solid #22314f; border-radius: 12px;
         padding: 10px 12px; color: #e6eeff; selection-background-color: #2b4f7d; }
#Input:focus { border-color: #35d6f5; }
#Hint { color: #5c6c86; font-size: 11px; }

#SendBtn { background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
            stop:0 #35d6f5, stop:1 #6d3bff);
           border: none; border-radius: 10px; color: #061225;
           font-weight: 700; padding: 10px 22px; }
#SendBtn:hover { background: qlineargradient(x1:0, y1:0, x2:1, y2:1,
                 stop:0 #5ae3ff, stop:1 #8255ff); }
#SendBtn:disabled { background: #1b2740; color: #5c6c86; }
#StopBtn { background: #2a1a26; border: 1px solid #6b3350; border-radius: 10px;
           color: #ff8fb0; padding: 10px 18px; }
#StopBtn:hover { background: #3a2033; }

QDialog { background: #101828; }
QLineEdit, QComboBox { background: #0d1626; border: 1px solid #22314f; border-radius: 8px;
                        padding: 7px 10px; color: #e6eeff; }
QLineEdit:focus, QComboBox:focus { border-color: #35d6f5; }
QComboBox QAbstractItemView { background: #0d1626; border: 1px solid #22314f;
                              selection-background-color: #1b2c4a; color: #e6eeff; }
#DlgOk { background: #35d6f5; color: #061225; border: none; border-radius: 8px;
         padding: 8px 20px; font-weight: 700; }
#DlgOk:hover { background: #5ae3ff; }
#DlgCancel { background: transparent; border: 1px solid #22314f; border-radius: 8px;
             padding: 8px 18px; color: #a9bcd9; }
#DlgCancel:hover { border-color: #35d6f5; }
#DlgTest { background: #1b2c4a; border: 1px solid #2b4f7d; border-radius: 8px;
           padding: 8px 18px; color: #cfd8ea; }
#DlgTest:hover { border-color: #35d6f5; color: #ffffff; }
#HintLabel { color: #64748b; font-size: 11px; }
QMessageBox { background: #101828; }
QScrollBar:vertical { background: transparent; width: 10px; margin: 2px; }
QScrollBar::handle:vertical { background: #22314f; border-radius: 5px; min-height: 28px; }
QScrollBar::handle:vertical:hover { background: #35d6f5; }
QScrollBar::add-line, QScrollBar::sub-line { height: 0; }
QScrollBar::add-page, QScrollBar::sub-page { background: transparent; }
"""

HTML_WRAP = """<html><head><style>
body { color:#d7e2f5; font-family:'Microsoft YaHei UI','Segoe UI'; font-size:13px; }
p { margin:5px 0; }
h1,h2,h3 { color:#e8f1ff; margin:9px 0 3px; }
ul,ol { margin:4px 0 4px 20px; }
li { margin:2px 0; }
code.ink { background:#16233b; color:#7ee6ff;
           font-family:Consolas,'Cascadia Mono'; padding:0 3px; }
pre.code { background:#0a1322; border:1px solid #22314f; border-left:3px solid #35d6f5;
           color:#cfe9ff; font-family:Consolas,'Cascadia Mono'; padding:8px; }
div.lang { color:#64748b; font-size:11px; }
a { color:#35d6f5; }
hr { border:none; border-top:1px solid #22314f; }
</style></head><body bgcolor="#101828">%s</body></html>"""


# ---------------------------------------------------------------- 错误中文化

def friendly_error(status=None, exc=None, raw=""):
    """把手里的异常 / 状态码翻成一句人话 + 一句下一步建议。"""
    detail = ""
    if raw:
        try:
            data = json.loads(raw)
            err = data.get("error", data)
            detail = err.get("message", "") if isinstance(err, dict) else str(err)
        except ValueError:
            detail = raw.strip()[:200]
    tail = ("（接口原文：%s）" % detail) if detail else ""

    if status == 401:
        return "401 认证失败：API Key 不正确、已失效或没带上。" + tail
    if status == 402:
        return "402 余额不足：账户额度用完了，去控制台充值后再试。" + tail
    if status == 403:
        return "403 没有权限：Key 可能没有该模型的调用权限，或所在地区受限。" + tail
    if status == 404:
        return "404 找不到接口：Base URL 或模型名写错了，Base URL 一般以 /v1 结尾。" + tail
    if status == 429:
        return "429 请求太频繁：触发限流了，等 1~2 分钟再发，或降低频率。" + tail
    if status and 500 <= status < 600:
        return "服务端错误（%d）：供应商临时故障，稍后重试。" % status + tail
    if status:
        return "请求失败（HTTP %d）" % status + tail

    if isinstance(exc, rex.SSLError):
        return "证书校验失败：可能是公司代理替换了证书。\n建议：确认代理软件的根证书已安装到系统，或关闭 HTTPS 抓包后重试。"
    if isinstance(exc, rex.ProxyError):
        return "代理连接失败：系统代理（HTTP_PROXY/HTTPS_PROXY）不可用。\n建议：检查代理软件是否在运行，或在设置里暂时清空代理环境变量。"
    if isinstance(exc, (rex.ConnectTimeout, rex.ReadTimeout)):
        return "请求超时（>%d 秒）：网络太慢或服务端卡住了。\n建议：换个网络 / 关掉代理再试。" % TIMEOUT
    if isinstance(exc, rex.ConnectionError):
        return "连接失败：域名解析不了或端口不通。\n建议：检查 Base URL、网络与代理设置；国内直连 OpenAI 通常需要代理。"
    if isinstance(exc, rex.MissingSchema):
        return "Base URL 格式不对：必须以 http:// 或 https:// 开头。"
    if isinstance(exc, requests.RequestException):
        return "网络请求出错：%s" % exc.__class__.__name__
    return "未知错误：%s" % exc


# ---------------------------------------------------------------- 对话工作线程

class ChatWorker(QThread):
    """在工作线程里跑 SSE 流式请求，通过信号回主线程刷新界面。"""

    chunk = Signal(str)     # 增量文本
    done = Signal()         # 正常结束
    failed = Signal(str)    # 已中文化的错误

    def __init__(self, cfg, messages, parent=None):
        super().__init__(parent)
        self._cfg = dict(cfg)
        self._messages = list(messages)
        self._stop = threading.Event()
        self._resp = None

    def stop(self):
        """置停止标志并断开连接，让 iter_lines 立刻退出。"""
        self._stop.set()
        resp = self._resp
        if resp is not None:
            try:
                resp.close()
            except Exception:
                pass

    def _handle_line(self, raw):
        """解析一行 SSE，返回本次增量文本（无增量返回空串）。"""
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            return ""
        payload = line[5:].strip()
        if payload == "[DONE]":
            return ""
        try:
            data = json.loads(payload)
        except ValueError:
            return ""
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(friendly_error(raw=json.dumps(data, ensure_ascii=False)))
        choices = data.get("choices") or []
        if not choices:
            return ""
        delta = choices[0].get("delta") or {}
        piece = delta.get("content") or ""
        if not piece:
            piece = delta.get("reasoning_content") or ""  # 推理模型兜底
        return piece

    def run(self):
        base = (self._cfg.get("base_url") or "").strip().rstrip("/")
        model = (self._cfg.get("model") or "").strip()
        key = (self._cfg.get("api_key") or "").strip()
        url = base + "/chat/completions"
        headers = {"Accept": "text/event-stream", "Content-Type": "application/json"}
        if key:
            headers["Authorization"] = "Bearer " + key
        payload = {
            "model": model,
            "messages": self._messages,
            "stream": True,
            "temperature": 0.7,
        }
        try:
            self._resp = requests.post(
                url, headers=headers, json=payload, stream=True, timeout=(15, TIMEOUT)
            )
            if self._resp.status_code != 200:
                body = ""
                try:
                    body = self._resp.text
                except Exception:
                    pass
                self.failed.emit(friendly_error(self._resp.status_code, raw=body))
                return
            for raw in self._resp.iter_lines(chunk_size=1, decode_unicode=False):
                if self._stop.is_set():
                    break
                if not raw:
                    continue
                piece = self._handle_line(raw)
                if piece:
                    self.chunk.emit(piece)
        except Exception as exc:  # 所有网络 / 解析异常统一收口
            if self._stop.is_set():
                self.done.emit()
                return
            if isinstance(exc, RuntimeError):
                self.failed.emit(str(exc))
            else:
                self.failed.emit(friendly_error(exc=exc))
            return
        self.done.emit()


# ---------------------------------------------------------------- Markdown 气泡

class MdView(QTextBrowser):
    """按内容自适应的富文本视图：不出现滚动条，高度随文本增长。"""

    MAX_WIDTH = 620

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setObjectName("BotText")
        self.setOpenExternalLinks(True)
        self.setFrameShape(QFrame.NoFrame)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        # QTextBrowser 的 viewport 默认白底，这里用调色板 + 显式底色压成卡片色
        pal = self.palette()
        pal.setColor(QPalette.Base, QColor("#101828"))
        pal.setColor(QPalette.Text, QColor("#d7e2f5"))
        self.setPalette(pal)
        self.setStyleSheet("QTextBrowser { background-color: #101828; border: none; }")
        self.document().setDocumentMargin(2)

    def render_md(self, source):
        """渲染并返回 (宽度, 高度)：宽度按最长一行估算，短消息不会撑满整行。"""
        self.setHtml(HTML_WRAP % md_to_html(source))
        doc = self.document()
        metrics = QFontMetrics(doc.defaultFont())
        longest = 0
        for line in source.split("\n"):
            longest = max(longest, metrics.horizontalAdvance(re.sub(r"[*`#>]", "", line)))
        width = int(min(self.MAX_WIDTH, max(220, longest + 46)))
        doc.setTextWidth(width)
        return width, int(max(26, doc.size().height() + 8))


class MessageBubble(QWidget):
    """一条消息：用户靠右浅蓝卡，助手靠左深色卡。"""

    def __init__(self, role, text="", parent=None):
        super().__init__(parent)
        self.setObjectName("Row")
        self.role = role
        self.raw = text if role == "assistant" else ""
        self.pending = role == "assistant" and not text

        outer = QHBoxLayout(self)
        outer.setContentsMargins(0, 4, 0, 4)
        outer.setSpacing(0)

        card = QFrame()
        card.setObjectName("BotBubble" if role == "assistant" else "UserBubble")
        card.setMaximumWidth(MdView.MAX_WIDTH + 24)
        inner = QVBoxLayout(card)
        inner.setContentsMargins(14, 10, 14, 12)
        inner.setSpacing(4)

        tag = QLabel("nanyang3Dcuit 助手" if role == "assistant" else "我")
        tag.setObjectName("Role")
        inner.addWidget(tag)

        if role == "assistant":
            self.text = MdView(card)
            inner.addWidget(self.text)
            self._apply(text or "正在思考…")
            outer.addWidget(card, 0, Qt.AlignLeft)
            outer.addStretch(1)
        else:
            self.text = QLabel(text)
            self.text.setObjectName("UserText")
            self.text.setWordWrap(True)
            self.text.setTextInteractionFlags(Qt.TextSelectableByMouse)
            self.text.setMaximumWidth(MdView.MAX_WIDTH)
            inner.addWidget(self.text)
            outer.addStretch(1)
            outer.addWidget(card, 0, Qt.AlignRight)

    def _apply(self, source):
        width, height = self.text.render_md(source)
        self.text.setFixedWidth(width + 2)
        self.text.setFixedHeight(height)

    def showEvent(self, event):
        # 构造时还没被 QSS 抛光，字号没定，尺寸会偏大；显示后按真实字体重算一次
        super().showEvent(event)
        if self.role == "assistant":
            self._apply(self.raw or "正在思考…")

    def append(self, piece):
        self.raw += piece
        self.pending = False
        self._apply(self.raw)

    def set_error(self, message):
        self.pending = False
        self.raw = message
        self._apply("**出错了：**\n\n" + message)

    def set_plain(self, message):
        self.pending = False
        self.raw = message
        self._apply(message)


# ---------------------------------------------------------------- 设置对话框

class SettingsDialog(QDialog):
    """模型与接口设置：预设供应商 -> 自动带 base_url / model。"""

    def __init__(self, cfg, parent=None):
        super().__init__(parent)
        self.cfg = dict(cfg)
        self.setWindowTitle("设置 · 模型与接口")
        self.setMinimumWidth(540)

        root = QVBoxLayout(self)
        root.setContentsMargins(20, 18, 20, 16)
        root.setSpacing(12)

        title = QLabel("连接云端模型")
        title.setObjectName("BrandTitle")
        root.addWidget(title)
        sub = QLabel("本程序不加载本地权重；只有这里填的 Key 会存到本机配置。")
        sub.setObjectName("HintLabel")
        root.addWidget(sub)

        form = QFormLayout()
        form.setSpacing(10)
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)

        self.provider_box = QComboBox()
        self.provider_box.addItems(list(PROVIDERS.keys()))
        if self.cfg.get("provider") in PROVIDERS:
            self.provider_box.setCurrentText(self.cfg["provider"])

        self.key_edit = QLineEdit(self.cfg.get("api_key", ""))
        self.key_edit.setEchoMode(QLineEdit.Password)
        self.key_edit.setPlaceholderText("sk-...（只保存在本机 config.json）")

        self.base_edit = QLineEdit(self.cfg.get("base_url", ""))
        self.base_edit.setPlaceholderText("https://api.deepseek.com/v1")

        self.model_edit = QLineEdit(self.cfg.get("model", ""))
        self.model_edit.setPlaceholderText("deepseek-chat")

        form.addRow("供应商", self.provider_box)
        form.addRow("API Key", self.key_edit)
        form.addRow("Base URL", self.base_edit)
        form.addRow("模型名", self.model_edit)
        root.addLayout(form)

        self.hint_label = QLabel("")
        self.hint_label.setObjectName("HintLabel")
        self.hint_label.setWordWrap(True)
        root.addWidget(self.hint_label)

        btns = QHBoxLayout()
        btns.setSpacing(10)
        self.test_btn = QPushButton("测试连接")
        self.test_btn.setObjectName("DlgTest")
        self.test_btn.clicked.connect(self.test_connection)
        self.cancel_btn = QPushButton("取消")
        self.cancel_btn.setObjectName("DlgCancel")
        self.cancel_btn.clicked.connect(self.reject)
        self.ok_btn = QPushButton("保存")
        self.ok_btn.setObjectName("DlgOk")
        self.ok_btn.clicked.connect(self.save_and_close)
        btns.addWidget(self.test_btn)
        btns.addStretch(1)
        btns.addWidget(self.cancel_btn)
        btns.addWidget(self.ok_btn)
        root.addLayout(btns)

        self.provider_box.currentTextChanged.connect(self.on_provider_changed)
        self.refresh_provider_hint()

    # -- 供应商联动

    def on_provider_changed(self, name):
        preset = PROVIDERS.get(name, {})
        # 切换预设时用默认值覆盖，自定义则保留用户已填内容
        if name != "自定义":
            self.base_edit.setText(preset.get("base_url", ""))
            self.model_edit.setText(preset.get("model", ""))
        self.refresh_provider_hint()

    def refresh_provider_hint(self):
        name = self.provider_box.currentText()
        hint = PROVIDERS.get(name, {}).get("hint", "")
        if name == "自定义":
            hint = "填任何 OpenAI 兼容服务的 Base URL（一般以 /v1 结尾）与模型名。"
        self.hint_label.setText(hint)

    # -- 测试连接

    def _probe(self):
        """返回 (是否成功, 说明文本)。先试 /models，不行再试一次极小对话。"""
        base = self.base_edit.text().strip().rstrip("/")
        model = self.model_edit.text().strip()
        key = self.key_edit.text().strip()
        if not base.startswith(("http://", "https://")):
            return False, "Base URL 必须以 http:// 或 https:// 开头。"
        headers = {}
        if key:
            headers["Authorization"] = "Bearer " + key
        try:
            r = requests.get(base + "/models", headers=headers, timeout=10)
            if r.status_code == 200:
                return True, "连接成功：服务可达，Key 有效。"
            # 部分网关不开放 /models，退回一次最小 chat 请求
            r2 = requests.post(
                base + "/chat/completions",
                headers=dict(headers, **{"Content-Type": "application/json"}),
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                    "stream": False,
                },
                timeout=15,
            )
            if r2.status_code == 200:
                return True, "连接成功：模型 %s 可用。" % (model or "（未填）")
            return False, friendly_error(r2.status_code, raw=r2.text)
        except Exception as exc:
            return False, friendly_error(exc=exc)

    def test_connection(self):
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            ok, msg = self._probe()
        finally:
            QApplication.restoreOverrideCursor()
        icon = QMessageBox.Information if ok else QMessageBox.Warning
        QMessageBox(icon, "测试连接", msg, QMessageBox.Ok, self).exec()

    # -- 保存

    def save_and_close(self):
        base = self.base_edit.text().strip().rstrip("/")
        model = self.model_edit.text().strip()
        if not base.startswith(("http://", "https://")):
            QMessageBox.warning(self, "无法保存", "Base URL 必须以 http:// 或 https:// 开头。")
            return
        if not model:
            QMessageBox.warning(self, "无法保存", "模型名不能为空，例如 deepseek-chat。")
            return
        self.cfg.update(
            {
                "provider": self.provider_box.currentText(),
                "api_key": self.key_edit.text().strip(),
                "base_url": base,
                "model": model,
            }
        )
        if not save_config(self.cfg):
            QMessageBox.warning(
                self, "保存失败", "写入 %s 失败，请检查目录权限。" % CONFIG_PATH
            )
            return
        self.accept()


# ---------------------------------------------------------------- 输入框

class Composer(QPlainTextEdit):
    """Enter 发送，Shift+Enter 换行。"""

    send_requested = Signal()

    def keyPressEvent(self, event):
        if event.key() in (Qt.Key_Return, Qt.Key_Enter):
            if event.modifiers() & Qt.ShiftModifier:
                super().keyPressEvent(event)
            else:
                self.send_requested.emit()
            return
        super().keyPressEvent(event)


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.cfg = load_config()
        self.sessions = self._load_sessions()
        self.worker = None
        self.current_bubble = None
        self.current_id = self.sessions[0]["id"] if self.sessions else ""
        self._loading = False
        self._stopped = False

        self.setWindowTitle("nanyang3Dcuit · 桌面工作台")
        self.resize(1180, 760)
        self.setMinimumSize(900, 600)
        self.setWindowIcon(make_icon())

        self._build_ui()
        if not self.sessions:
            self.new_session(switch=False)
        self.refresh_session_list()
        self.load_session(self.current_id)
        self.refresh_status()

    # -- 会话落盘

    def _load_sessions(self):
        data = load_json(SESSIONS_PATH, [])
        if not isinstance(data, list):
            return []
        clean = []
        for s in data:
            if not isinstance(s, dict) or not isinstance(s.get("messages"), list):
                continue
            clean.append(
                {
                    "id": str(s.get("id") or uuid.uuid4().hex[:8]),
                    "title": str(s.get("title") or "新会话"),
                    "created": str(s.get("created") or now_str()),
                    "messages": [
                        {"role": m["role"], "content": m["content"]}
                        for m in s["messages"]
                        if isinstance(m, dict)
                        and m.get("role") in ("user", "assistant")
                        and isinstance(m.get("content"), str)
                    ],
                }
            )
        return clean

    def save_sessions(self):
        save_json(SESSIONS_PATH, self.sessions)

    def session_by_id(self, sid):
        for s in self.sessions:
            if s["id"] == sid:
                return s
        return None

    def current_session(self):
        return self.session_by_id(self.current_id)

    def new_session(self, switch=True):
        if self.worker and self.worker.isRunning():
            self.toast_status("正在生成，先停止再新建", 3000)
            return
        session = {
            "id": uuid.uuid4().hex[:8],
            "title": "新会话",
            "created": now_str(),
            "messages": [],
        }
        self.sessions.insert(0, session)
        self.save_sessions()
        if switch:
            self.current_id = session["id"]
            self.refresh_session_list()
            self.load_session(self.current_id)
        return session

    def delete_session(self, sid):
        if self.worker and self.worker.isRunning():
            QMessageBox.information(self, "提示", "正在生成回复，请先停止。")
            return
        self.sessions = [s for s in self.sessions if s["id"] != sid]
        if not self.sessions:
            self.new_session(switch=False)
        if self.current_id == sid:
            self.current_id = self.sessions[0]["id"]
        self.save_sessions()
        self.refresh_session_list()
        self.load_session(self.current_id)

    def refresh_session_list(self):
        self._loading = True
        self.session_list.clear()
        for s in self.sessions:
            item = QListWidgetItem(s["title"])
            item.setData(Qt.UserRole, s["id"])
            item.setToolTip("%s · %s" % (s["title"], s["created"]))
            self.session_list.addItem(item)
            if s["id"] == self.current_id:
                self.session_list.setCurrentItem(item)
        self._loading = False

    def on_session_selected(self, item):
        if self._loading or item is None:
            return
        sid = item.data(Qt.UserRole)
        if not sid or sid == self.current_id:
            return
        if self.worker and self.worker.isRunning():
            self.toast_status("正在生成，先停止再切换会话", 3000)
            # 把选中状态还原到当前会话
            self.refresh_session_list()
            return
        self.current_id = sid
        self.load_session(sid)

    def load_session(self, sid):
        session = self.session_by_id(sid)
        self._clear_messages()
        if session:
            for msg in session["messages"]:
                bubble = MessageBubble(msg["role"], msg["content"])
                self.add_bubble(bubble)
        self.scroll_to_bottom()

    def auto_title(self, text):
        """首条用户消息自动命名，超过 18 字截断。"""
        session = self.current_session()
        if not session or session["messages"][:-1]:
            return
        name = re.sub(r"\s+", " ", text).strip()
        session["title"] = (name[:18] + "…") if len(name) > 18 else name
        self.refresh_session_list()

    def _clear_messages(self):
        while self.msg_layout.count() > 1:
            item = self.msg_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def add_bubble(self, bubble):
        self.msg_layout.insertWidget(self.msg_layout.count() - 1, bubble)
        return bubble

    # -- 界面搭建

    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)

        # 左：侧边栏
        side = QFrame()
        side.setObjectName("Sidebar")
        side.setFixedWidth(240)
        side_layout = QVBoxLayout(side)
        side_layout.setContentsMargins(16, 18, 16, 14)
        side_layout.setSpacing(10)

        brand = QHBoxLayout()
        brand.setSpacing(10)
        mark = QLabel("3D")
        mark.setObjectName("BrandMark")
        mark.setFixedSize(42, 42)
        mark.setAlignment(Qt.AlignCenter)
        brand.addWidget(mark)
        names = QVBoxLayout()
        names.setSpacing(0)
        title = QLabel("nanyang3Dcuit")
        title.setObjectName("BrandTitle")
        sub = QLabel("本地工作台")
        sub.setObjectName("BrandSub")
        names.addWidget(title)
        names.addWidget(sub)
        brand.addLayout(names)
        brand.addStretch(1)
        side_layout.addLayout(brand)

        self.new_btn = QPushButton("+  新建会话")
        self.new_btn.setObjectName("NewChat")
        self.new_btn.setCursor(Qt.PointingHandCursor)
        self.new_btn.clicked.connect(lambda: self.new_session(True))
        side_layout.addWidget(self.new_btn)

        self.session_list = QListWidget()
        self.session_list.setObjectName("SessionList")
        self.session_list.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.session_list.setContextMenuPolicy(Qt.CustomContextMenu)
        self.session_list.customContextMenuRequested.connect(self.show_session_menu)
        self.session_list.currentItemChanged.connect(
            lambda cur, _prev: self.on_session_selected(cur)
        )
        side_layout.addWidget(self.session_list, 1)

        self.settings_btn = QPushButton("设置与模型")
        self.settings_btn.setObjectName("SettingsBtn")
        self.settings_btn.setCursor(Qt.PointingHandCursor)
        self.settings_btn.clicked.connect(self.open_settings)
        side_layout.addWidget(self.settings_btn)
        root.addWidget(side)

        # 右：对话区
        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        right_layout.setSpacing(0)

        top = QFrame()
        top.setObjectName("TopBar")
        top.setFixedHeight(52)
        top_layout = QHBoxLayout(top)
        top_layout.setContentsMargins(18, 0, 16, 0)
        top_layout.setSpacing(8)
        self.model_label = QLabel("未配置模型")
        self.model_label.setObjectName("ModelName")
        self.dot_label = QLabel("●")
        self.dot_label.setObjectName("Dot")
        self.status_label = QLabel("就绪")
        self.status_label.setObjectName("StatusText")
        top_layout.addWidget(self.model_label)
        top_layout.addWidget(self.dot_label)
        top_layout.addWidget(self.status_label)
        top_layout.addStretch(1)
        for text, handler in (
            ("网页版", self.open_web),
            ("GitHub", self.open_repo),
            ("产物目录", self.open_outputs),
        ):
            btn = QPushButton(text)
            btn.setObjectName("ToolBtn")
            btn.setCursor(Qt.PointingHandCursor)
            btn.clicked.connect(handler)
            top_layout.addWidget(btn)
        right_layout.addWidget(top)

        self.scroll = QScrollArea()
        self.scroll.setObjectName("Scroll")
        self.scroll.setWidgetResizable(True)
        self.scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        column = QWidget()
        column.setObjectName("MsgCol")
        self.msg_layout = QVBoxLayout(column)
        self.msg_layout.setContentsMargins(28, 20, 28, 20)
        self.msg_layout.setSpacing(4)
        self.msg_layout.addStretch(1)
        self.scroll.setWidget(column)
        right_layout.addWidget(self.scroll, 1)

        composer = QFrame()
        composer.setObjectName("Composer")
        composer_layout = QVBoxLayout(composer)
        composer_layout.setContentsMargins(18, 12, 18, 12)
        composer_layout.setSpacing(8)

        row = QHBoxLayout()
        row.setSpacing(10)
        self.input = Composer()
        self.input.setObjectName("Input")
        self.input.setPlaceholderText("描述角色、行走图或 3D 需求…（Enter 发送，Shift+Enter 换行）")
        self.input.setMinimumHeight(70)
        self.input.setMaximumHeight(150)
        self.input.send_requested.connect(self.send_message)
        row.addWidget(self.input, 1)

        self.send_btn = QPushButton("发送")
        self.send_btn.setObjectName("SendBtn")
        self.send_btn.setCursor(Qt.PointingHandCursor)
        self.send_btn.clicked.connect(self.send_message)
        row.addWidget(self.send_btn)

        self.stop_btn = QPushButton("停止")
        self.stop_btn.setObjectName("StopBtn")
        self.stop_btn.setCursor(Qt.PointingHandCursor)
        self.stop_btn.setEnabled(False)
        self.stop_btn.clicked.connect(self.stop_generation)
        row.addWidget(self.stop_btn)
        composer_layout.addLayout(row)

        hint = QLabel("本机不跑大模型 · 仅调用你配置的云端 API · Key 保存在 %APPDATA%\\Nanyang3Dcuit")
        hint.setObjectName("Hint")
        hint.setWordWrap(True)
        composer_layout.addWidget(hint)
        right_layout.addWidget(composer)
        root.addWidget(right, 1)

    # -- 对话流程

    def send_message(self):
        if self.worker is not None and self.worker.isRunning():
            return
        text = self.input.toPlainText().strip()
        if not text:
            return
        if not self.cfg.get("api_key"):
            QMessageBox.information(
                self,
                "还没填 API Key",
                "请先在「设置与模型」里填 API Key，再回来发送。\n"
                "本程序只把 Key 存到 %s。" % CONFIG_PATH,
            )
            self.open_settings()
            return
        session = self.current_session()
        if session is None:
            session = self.new_session(switch=True)

        user_bubble = MessageBubble("user", text)
        self.add_bubble(user_bubble)
        session["messages"].append({"role": "user", "content": text})
        if len(session["messages"]) == 1:
            self.auto_title(text)
        else:
            self.refresh_session_list()
        self.save_sessions()

        self.input.clear()
        self.current_bubble = self.add_bubble(MessageBubble("assistant"))
        self.scroll_to_bottom()

        history = [
            {"role": m["role"], "content": m["content"]}
            for m in session["messages"][-20:]
        ]
        payload = [{"role": "system", "content": SYSTEM_PROMPT}] + history

        self._stopped = False
        self.worker = ChatWorker(self.cfg, payload, self)
        self.worker.chunk.connect(self.on_chunk)
        self.worker.done.connect(self.on_stream_done)
        self.worker.failed.connect(self.on_stream_failed)
        self.worker.finished.connect(self.worker.deleteLater)
        self.worker.start()
        self.set_busy(True)
        self.status_label.setText("正在生成…")

    def on_chunk(self, piece):
        if self.current_bubble is not None:
            self.current_bubble.append(piece)
            self.scroll_to_bottom()

    def on_stream_done(self):
        bubble = self.current_bubble
        session = self.current_session()
        if bubble is not None:
            if bubble.raw.strip():
                if session is not None:
                    session["messages"].append({"role": "assistant", "content": bubble.raw})
                    self.save_sessions()
            else:
                bubble.set_plain("（没有返回内容）" if not self._stopped else "（已停止）")
        self.current_bubble = None
        self.set_busy(False)
        self.status_label.setText("已停止" if self._stopped else "就绪")

    def on_stream_failed(self, message):
        if self.current_bubble is not None:
            self.current_bubble.set_error(message)
        self.current_bubble = None
        self.set_busy(False)
        self.status_label.setText("出错")
        self.scroll_to_bottom()

    def stop_generation(self):
        if self.worker is not None and self.worker.isRunning():
            self._stopped = True
            self.worker.stop()
            self.status_label.setText("正在停止…")

    def set_busy(self, busy):
        self.send_btn.setEnabled(not busy)
        self.stop_btn.setEnabled(busy)
        self.dot_label.setStyleSheet("color: #6d3bff;" if busy else "color: #35d6f5;")

    # -- 状态 / 工具

    def refresh_status(self):
        model = (self.cfg.get("model") or "").strip()
        provider = (self.cfg.get("provider") or "").strip()
        self.model_label.setText(
            ("%s · %s" % (model, provider)) if model else "未配置模型"
        )
        self.status_label.setText("就绪" if self.cfg.get("api_key") else "未填 API Key")

    def toast_status(self, text, msec=2500):
        self.status_label.setText(text)
        QTimer.singleShot(msec, self.refresh_status)

    def open_settings(self):
        dlg = SettingsDialog(self.cfg, self)
        if dlg.exec() == QDialog.Accepted:
            self.cfg = load_config()
            self.refresh_status()
            self.toast_status("设置已保存")

    def open_web(self):
        if not webbrowser.open(WEB_URL):
            QMessageBox.warning(self, "打不开", "无法调用系统浏览器，请手动访问：\n" + WEB_URL)

    def open_repo(self):
        if not webbrowser.open(REPO_URL):
            QMessageBox.warning(self, "打不开", "无法调用系统浏览器，请手动访问：\n" + REPO_URL)

    def open_outputs(self):
        out_dir = os.path.join(PROJECT_ROOT, "out")
        ensure_dir(out_dir)
        if not open_path(out_dir):
            QMessageBox.warning(self, "打不开", "无法打开目录：\n" + out_dir)

    def show_session_menu(self, pos):
        item = self.session_list.itemAt(pos)
        if item is None:
            return
        sid = item.data(Qt.UserRole)
        menu = QMenu(self)
        act_del = menu.addAction("删除会话")
        act_new = menu.addAction("新建会话")
        chosen = menu.exec(self.session_list.mapToGlobal(pos))
        if chosen == act_del:
            self.delete_session(sid)
        elif chosen == act_new:
            self.new_session(True)

    def scroll_to_bottom(self):
        bar = self.scroll.verticalScrollBar()
        QTimer.singleShot(0, lambda: bar.setValue(bar.maximum()))

    def closeEvent(self, event):
        if self.worker is not None and self.worker.isRunning():
            self.worker.stop()
            self.worker.wait(1500)
        event.accept()


# ---------------------------------------------------------------- 入口

def make_icon():
    """窗口图标：青蓝圆角方块 + 3D 字样，不额外依赖图片资源。"""
    pix = QPixmap(64, 64)
    pix.fill(Qt.transparent)
    painter = QPainter(pix)
    painter.setRenderHint(QPainter.Antialiasing)
    painter.setPen(Qt.NoPen)
    painter.setBrush(QColor("#35d6f5"))
    painter.drawRoundedRect(2, 2, 60, 60, 14, 14)
    painter.setPen(QColor("#061225"))
    font = QFont("Segoe UI", 24)
    font.setBold(True)
    painter.setFont(font)
    painter.drawText(pix.rect(), Qt.AlignCenter, "3D")
    painter.end()
    return QIcon(pix)


def run_selftest(argv):
    """无界面自检：建窗口、渲染一次、打印 OK 后退出。"""
    app = QApplication(argv)
    app.setStyleSheet(QSS)
    win = MainWindow()
    win.resize(1180, 760)
    win.show()
    app.processEvents()
    shot = win.grab()  # 强制走一次完整绘制
    if shot.isNull():
        print("FAIL: 渲染结果为空")
        return 1
    print("OK")
    win.close()
    return 0


def main():
    if "--selftest" in sys.argv:
        return run_selftest([a for a in sys.argv if a != "--selftest"])
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setStyleSheet(QSS)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
