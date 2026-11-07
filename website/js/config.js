/* 配置与通用工具：所有模块共享 NY 命名空间 */
window.NY = window.NY || {};

(function () {
  const STORAGE_KEY = 'nanyang3dcuit.v1';

  // 只保存用户真正需要跨会话保留的东西（Key 存在本机 localStorage）
  const DEFAULTS = {
    baseUrl: '',
    apiKey: '',
    model: 'gpt-4o-mini',
    space: 'tencent/Hunyuan3D-2',
    restUrl: '',
    repoUrl: 'https://github.com/Yang1235744/nanyang3Dcuit',
  };

  const config = {
    data: Object.assign({}, DEFAULTS),

    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) Object.assign(this.data, JSON.parse(raw));
      } catch (err) {
        console.warn('[config] 读取本地设置失败，使用默认值', err);
      }
      return this.data;
    },

    save(patch) {
      Object.assign(this.data, patch || {});
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
        return true;
      } catch (err) {
        console.warn('[config] 保存失败', err);
        return false;
      }
    },

    clear() {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        console.warn('[config] 清除失败', err);
      }
      this.data = Object.assign({}, DEFAULTS);
    },

    hasAgent() {
      return Boolean(this.data.baseUrl && this.data.apiKey && this.data.model);
    },
  };

  config.load();
  NY.config = config;

  /* ---------- 通用工具 ---------- */
  const util = {
    formatBytes(bytes) {
      if (!bytes) return '0 B';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(2) + ' MB';
    },

    escapeHtml(str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    },

    // 把换行和简单 markdown 转成安全 HTML（不引入外部依赖）
    textToHtml(str) {
      return util
        .escapeHtml(str)
        .replace(/```([\s\S]*?)```/g, (m, code) => '<code>' + code.trim() + '</code>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
    },

    downloadBlob(blob, filename) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // 立刻 revoke 会让部分浏览器取消下载，延后释放
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    },

    // 给日志上色：以 [完成] / [失败] / [提示] 开头做简单高亮
    paintLog(text) {
      return util
        .escapeHtml(text)
        .replace(/\[完成\](.*)/g, '<span class="ok">[完成]$1</span>')
        .replace(/\[失败\](.*)/g, '<span class="err">[失败]$1</span>')
        .replace(/\[校验\]/g, '<span class="ok">[校验]</span>')
        .replace(/\[提示\]/g, '<span class="warn">[提示]</span>');
    },

    // 读取文件为图片元素
    loadImage(file) {
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          resolve(img);
        };
        img.onerror = () => {
          URL.revokeObjectURL(url);
          reject(new Error('图片无法解码：' + file.name));
        };
        img.src = url;
      });
    },
  };

  NY.util = util;
})();
