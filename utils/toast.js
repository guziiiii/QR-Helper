/**
 * Toast 浮动通知模块
 *
 * 在鼠标附近显示浮出动画结果通知
 * 支持成功/失败/进行中三种状态
 * 所有文案通过 chrome.i18n.getMessage() 实现国际化
 *
 * 使用方式：
 *   Toast.show('Scanning QR code...', x, y, 'info');
 *   Toast.show('QR detected!', x, y, 'success');
 *   Toast.show('Failed', x, y, 'error');
 *   Toast.hide();
 */

// ---------------------------------------------------------------------------
// CSS 样式注入（仅在首次调用时执行一次）
// ---------------------------------------------------------------------------

var TOAST_STYLES_INJECTED = false;

/**
 * 注入 Toast 样式到页面中
 */
function injectToastStyles() {
  if (TOAST_STYLES_INJECTED) return;

  var style = document.createElement('style');
  style.id = 'qr-helper-toast-styles';
  style.textContent =
    /* Toast 容器 */
    '#qr-helper-toast {' +
    '  position: fixed;' +
    '  z-index: 2147483647;' + /* 最高层级 */
    '  pointer-events: none;' + /* 不阻挡鼠标操作 */
    '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;' +
    '  font-size: 13px;' +
    '  line-height: 1.5;' +
    '  max-width: 420px;' +
    '  max-height: 160px;' +
    '  overflow: hidden;' +
    '  text-overflow: ellipsis;' +
    '  padding: 8px 14px;' +
    '  border-radius: 8px;' +
    '  box-shadow: 0 4px 12px rgba(0,0,0,0.2);' +
    '  opacity: 0;' +
    '  transition: opacity 0.25s ease-in-out, transform 0.25s ease-out;' +
    '  transform: translateY(8px);' +
    '  word-break: break-all;' +
    '  white-space: pre-wrap;' +
    '  /* 默认隐藏，由 JS 控制位置 */' +
    '  top: 0;' +
    '  left: 0;' +
    '}' +
    /* 可见状态 */
    '#qr-helper-toast.visible {' +
    '  opacity: 1;' +
    '  transform: translateY(0);' +
    '}' +
    /* 成功（信息类） */
    '#qr-helper-toast.info {' +
    '  background: #1976D2;' +
    '  color: #ffffff;' +
    '}' +
    /* 成功 */
    '#qr-helper-toast.success {' +
    '  background: #388E3C;' +
    '  color: #ffffff;' +
    '}' +
    /* 错误 */
    '#qr-helper-toast.error {' +
    '  background: #D32F2F;' +
    '  color: #ffffff;' +
    '}' +
    /* 进行中 */
    '#qr-helper-toast.progress {' +
    '  background: #F57C00;' +
    '  color: #ffffff;' +
    '}';

  document.head.appendChild(style);
  TOAST_STYLES_INJECTED = true;
}

// ---------------------------------------------------------------------------
// Toast 容器管理
// ---------------------------------------------------------------------------

/**
 * 获取或创建 Toast DOM 元素
 * @returns {HTMLElement}
 */
function getToastElement() {
  var toast = document.getElementById('qr-helper-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'qr-helper-toast';
    document.body.appendChild(toast);
  }
  return toast;
}

// ---------------------------------------------------------------------------
// 定时器管理
// ---------------------------------------------------------------------------

var toastHideTimer = null;

// ---------------------------------------------------------------------------
// 核心 API
// ---------------------------------------------------------------------------

/**
 * Toast 模块命名空间
 */
var Toast = {
  /**
   * 显示一个 Toast 通知
   *
   * @param {string} message - 要显示的消息文本
   * @param {number} mouseX - 鼠标 X 坐标（视口坐标）
   * @param {number} mouseY - 鼠标 Y 坐标（视口坐标）
   * @param {string} [type='info'] - 类型：'info' / 'success' / 'error' / 'progress'
   * @param {number} [duration=2500] - 显示时长（毫秒），0 表示不自动隐藏
   */
  show: function (message, mouseX, mouseY, type, duration) {
    // 参数默认值
    type = type || 'info';
    duration = duration !== undefined ? duration : 2500;

    // 注入样式（仅首次）
    injectToastStyles();

    // 获取或创建 Toast 元素
    var toast = getToastElement();

    // 设置文本
    toast.textContent = message;

    // 设置类型样式
    toast.className = type;

    // 计算位置：在鼠标右下方偏移，但不超过视口边界
    var offsetX = 16; // 鼠标右方偏移
    var offsetY = 20; // 鼠标下方偏移

    var posX = mouseX + offsetX;
    var posY = mouseY + offsetY;

    // 先设置位置但不显示，让浏览器计算实际尺寸
    toast.style.top = posY + 'px';
    toast.style.left = posX + 'px';

    // 使用 requestAnimationFrame 确保布局完成后检测视口边界再显示
    requestAnimationFrame(function () {
      var rect = toast.getBoundingClientRect();
      var viewW = window.innerWidth;
      var viewH = window.innerHeight;

      // 右边界溢出 → 翻转到鼠标左方
      if (rect.right > viewW) {
        posX = mouseX - rect.width - offsetX;
        if (posX < 8) posX = 8;
        toast.style.left = posX + 'px';
      }

      // 下边界溢出 → 翻转到鼠标上方
      if (rect.bottom > viewH) {
        posY = mouseY - rect.height - offsetY;
        if (posY < 8) posY = 8;
        toast.style.top = posY + 'px';
      }

      // 显示开始动画
      toast.classList.add('visible');
    });

    // 清除之前的自动隐藏定时器
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }

    // 自动隐藏
    if (duration > 0) {
      toastHideTimer = setTimeout(function () {
        Toast.hide();
      }, duration);
    }
  },

  /**
   * 隐藏 Toast
   */
  hide: function () {
    var toast = document.getElementById('qr-helper-toast');
    if (toast) {
      toast.classList.remove('visible');
    }
    if (toastHideTimer) {
      clearTimeout(toastHideTimer);
      toastHideTimer = null;
    }
  },

  /**
   * 显示扫描成功通知（带解码内容）
   *
   * @param {string} decodedText - 解码出的文本
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showScanSuccess: function (decodedText, mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_scanSuccess', decodedText);
    Toast.show(msg, mouseX, mouseY, 'success');
  },

  /**
   * 显示扫描失败通知
   *
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showScanFailed: function (mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_scanFailed');
    Toast.show(msg, mouseX, mouseY, 'error');
  },

  /**
   * 显示扫描错误通知
   *
   * @param {string} errorReason - 错误原因
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showScanError: function (errorReason, mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_scanError', errorReason);
    Toast.show(msg, mouseX, mouseY, 'error');
  },

  /**
   * 显示复制成功通知
   *
   * @param {string} content - 复制的内容
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showCopySuccess: function (content, mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_copySuccess', content);
    Toast.show(msg, mouseX, mouseY, 'success');
  },

  /**
   * 显示复制失败通知
   *
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showCopyFailed: function (mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_copyFailed');
    Toast.show(msg, mouseX, mouseY, 'error');
  },

  /**
   * 显示正在扫描通知
   *
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showScanning: function (mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_scanning');
    Toast.show(msg, mouseX, mouseY, 'progress', 0); // 不自动隐藏
  },

  /**
   * 显示 QR 生成成功通知
   *
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showGenerateSuccess: function (mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_generateSuccess');
    Toast.show(msg, mouseX, mouseY, 'success');
  },

  /**
   * 显示 QR 生成失败通知
   *
   * @param {string} reason - 失败原因
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showGenerateFailed: function (reason, mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_generateFailed', reason);
    Toast.show(msg, mouseX, mouseY, 'error');
  },

  /**
   * 显示正在打开链接通知
   *
   * @param {number} mouseX - 鼠标 X 坐标
   * @param {number} mouseY - 鼠标 Y 坐标
   */
  showOpeningLink: function (mouseX, mouseY) {
    var msg = chrome.i18n.getMessage('toast_isURL');
    Toast.show(msg, mouseX, mouseY, 'info');
  }
};
