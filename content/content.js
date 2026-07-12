/**
 * Content Script — 注入到每个页面中
 *
 * 功能：
 * - 长按图片检测（pointerdown + 600ms 定时器），附带进度边框指示
 * - 从图片提取像素数据（同源用 canvas、跨域委托给 Service Worker）
 * - 长按触发后阻止后续 click/pointerup 事件防止误触（如打开预览图）
 * - 监听 Background 发来的消息并展示结果
 * - 调用 Toast 模块在鼠标附近显示浮出通知
 * - 处理剪贴板复制
 *
 * 依赖（通过 manifest content_scripts 的 js 数组按序注入）：
 *   1. lib/zxing-wasm-full.js  → ZXingWASM
 *   2. utils/zxing-loader.js   → QRModule
 *   3. utils/toast.js          → Toast
 *   4. content/content.js      → 本文件
 */

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 长按判定时间（毫秒） */
var LONG_PRESS_DURATION = 600;

/** 鼠标移动阈值（像素），超过则取消长按 */
var LONG_PRESS_MOVE_THRESHOLD = 10;

/** 扫描超时（毫秒） */
var SCAN_TIMEOUT = 10000;

/** 长按定时器 ID */
var longPressTimer = null;

/** 长按是否已触发（用于阻止 contextmenu 和后续 click） */
var longPressTriggered = false;

/** 长按进度蒙层 DOM 元素 */
var longPressOverlay = null;

/** 长按起始坐标（用于移动检测） */
var longPressStartX = 0;
var longPressStartY = 0;

/** 当前鼠标坐标（用于 Toast 定位） */
var currentMouseX = 0;
var currentMouseY = 0;

/** 长按扫描是否启用（从 chrome.storage.sync 读取） */
var enableLongPress = true;

// ---------------------------------------------------------------------------
// 设置加载
// ---------------------------------------------------------------------------

/**
 * 从 storage 加载长按扫描开关状态
 */
function loadLongPressSetting() {
  chrome.storage.sync.get('enableLongPress', function (items) {
    if (items.enableLongPress !== undefined) {
      enableLongPress = items.enableLongPress;
    }
  });
}

// 监听存储变更，动态开关长按
chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName === 'sync' && changes.enableLongPress) {
    enableLongPress = changes.enableLongPress.newValue;
  }
});

// 启动时读取
loadLongPressSetting();

// ---------------------------------------------------------------------------
// 长按检测
// ---------------------------------------------------------------------------

/**
 * 处理长按触发 — 对目标图片进行 QR 扫描
 */
function handleLongPressOnImage(imgElement, mouseX, mouseY) {
  // 显示"扫描中"的 Toast
  Toast.showScanning(mouseX, mouseY);

  // 移除进度蒙层（长按已触发，边框指示已完成）
  removeLongPressProgress();

  // 尝试从图片中提取数据进行 QR 扫描
  scanImageElement(imgElement, mouseX, mouseY);
}

/**
 * 在图片上显示进度边框指示
 */
function showLongPressProgress(imgElement) {
  if (!imgElement || longPressOverlay) return;

  var rect = imgElement.getBoundingClientRect();

  var overlay = document.createElement('div');
  overlay.id = 'qr-helper-longpress-overlay';
  overlay.style.cssText =
    'position:fixed;z-index:2147483646;pointer-events:none;' +
    'border:3px solid #1976D2;border-radius:4px;' +
    'box-sizing:border-box;opacity:0;' +
    'transition:opacity 0.2s ease-in;' +
    'left:' + rect.left + 'px;top:' + rect.top + 'px;' +
    'width:' + rect.width + 'px;height:' + rect.height + 'px;';

  document.body.appendChild(overlay);
  longPressOverlay = overlay;

  requestAnimationFrame(function () {
    overlay.style.opacity = '1';
  });
}

/**
 * 移除长按进度蒙层
 */
function removeLongPressProgress() {
  if (longPressOverlay) {
    longPressOverlay.style.opacity = '0';
    setTimeout(function () {
      if (longPressOverlay && longPressOverlay.parentNode) {
        longPressOverlay.parentNode.removeChild(longPressOverlay);
      }
      longPressOverlay = null;
    }, 300);
  }
}

/**
 * 长按开始：设置定时器 + 启动进度指示
 */
document.addEventListener('pointerdown', function (event) {
  // 如果长按扫描已关闭，跳过
  if (!enableLongPress) return;

  // 只处理图片上的长按，且仅限左键（button === 0）
  if (event.button !== 0) return;

  var target = event.target;
  var imgElement = findClosestImage(target);
  if (!imgElement) return;

  // 记录鼠标位置
  currentMouseX = event.clientX;
  currentMouseY = event.clientY;
  longPressStartX = event.clientX;
  longPressStartY = event.clientY;
  longPressTriggered = false;

  // 设置长按定时器
  longPressTimer = setTimeout(function () {
    longPressTriggered = true;
    handleLongPressOnImage(imgElement, currentMouseX, currentMouseY);
  }, LONG_PRESS_DURATION);

  // 显示进度边框指示（等一帧避免闪烁）
  requestAnimationFrame(function () {
    showLongPressProgress(imgElement);
  });
}, true); // 捕获阶段

/**
 * 长按取消：鼠标松开
 * 若长按已触发，阻止默认行为（防止页面响应 click 打开预览图等）
 */
document.addEventListener('pointerup', function (event) {
  if (longPressTriggered) {
    // 长按已触发：阻止后续 click 事件
    event.preventDefault();
    event.stopImmediatePropagation();
    longPressTriggered = false;
  }
  clearLongPressTimer();
  removeLongPressProgress();
}, true);

/**
 * 长按取消：鼠标离开
 */
document.addEventListener('pointerleave', function () {
  clearLongPressTimer();
  removeLongPressProgress();
}, true);

/**
 * 长按取消：鼠标移动超过阈值
 */
document.addEventListener('pointermove', function (event) {
  if (longPressTimer) {
    var dx = Math.abs(event.clientX - longPressStartX);
    var dy = Math.abs(event.clientY - longPressStartY);
    if (dx > LONG_PRESS_MOVE_THRESHOLD || dy > LONG_PRESS_MOVE_THRESHOLD) {
      clearLongPressTimer();
      removeLongPressProgress();
    }
  }
  currentMouseX = event.clientX;
  currentMouseY = event.clientY;
}, true);

/**
 * 额外阻止 click 事件冒泡：长按触发后，防止页面链接/预览等响应
 */
document.addEventListener('click', function (event) {
  if (longPressTriggered) {
    event.preventDefault();
    event.stopImmediatePropagation();
    longPressTriggered = false;
  }
}, true);

/**
 * 阻止由长按触发的原生右键菜单
 */
document.addEventListener('contextmenu', function (event) {
  if (longPressTriggered) {
    event.preventDefault();
    event.stopPropagation();
    longPressTriggered = false;
  }
}, true);

/**
 * 清除长按定时器
 */
function clearLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer);
    longPressTimer = null;
  }
}

// ---------------------------------------------------------------------------
// 图片元素处理
// ---------------------------------------------------------------------------

function findClosestImage(element) {
  if (element.tagName === 'IMG') return element;

  var img = element.querySelector('img');
  if (img) return img;

  var parent = element;
  while (parent && parent.tagName !== 'IMG') {
    parent = parent.parentElement;
  }
  if (parent && parent.tagName === 'IMG') return parent;

  return null;
}

function scanImageElement(imgElement, mouseX, mouseY) {
  var imageUrl = imgElement.src;

  if (isCrossOriginImage(imgElement) && !isDataUrl(imageUrl)) {
    scanCrossOriginImage(imageUrl, mouseX, mouseY);
  } else {
    scanSameOriginImage(imgElement, mouseX, mouseY);
  }
}

function isCrossOriginImage(img) {
  if (!img || !img.src) return false;
  if (img.src.indexOf('data:') === 0 || img.src.indexOf('blob:') === 0) return false;

  try {
    var imgUrl = new URL(img.src);
    var currentUrl = new URL(window.location.href);
    return imgUrl.origin !== currentUrl.origin;
  } catch (e) {
    return false;
  }
}

function isDataUrl(url) {
  return url && url.indexOf('data:') === 0;
}

function extractImageData(imgElement) {
  try {
    var canvas = document.createElement('canvas');
    var width = imgElement.naturalWidth || imgElement.width;
    var height = imgElement.naturalHeight || imgElement.height;

    var MAX_DIMENSION = 2048;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      var scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    canvas.width = width;
    canvas.height = height;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(imgElement, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height);
  } catch (err) {
    console.warn('[QR Helper] Failed to extract image data:', err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 扫描逻辑
// ---------------------------------------------------------------------------

function scanSameOriginImage(imgElement, mouseX, mouseY) {
  var imageData = extractImageData(imgElement);
  if (!imageData) {
    Toast.hide();
    Toast.showScanError('Failed to read image data', mouseX, mouseY);
    return;
  }

  QRModule.readQR(imageData).then(function (result) {
    handleScanResult(result, mouseX, mouseY);
  }).catch(function (err) {
    Toast.hide();
    Toast.showScanError(err.message, mouseX, mouseY);
  });
}

/**
 * 扫描跨域图片（委托给 Service Worker，带超时）
 */
function scanCrossOriginImage(imageUrl, mouseX, mouseY) {
  var timedOut = false;
  var timeoutId = setTimeout(function () {
    timedOut = true;
    Toast.hide();
    Toast.showScanError('Scan timed out after ' + (SCAN_TIMEOUT / 1000) + 's', mouseX, mouseY);
  }, SCAN_TIMEOUT);

  chrome.runtime.sendMessage({
    action: 'fetchAndScanImage',
    imageUrl: imageUrl,
    pageOrigin: window.location.origin  // 传递当前页面 origin 给 SW 用作 Referer
  }, function (response) {
    if (timedOut) return; // 超时已处理，忽略

    clearTimeout(timeoutId);

    if (response && response.success) {
      handleScanResult(response.result, mouseX, mouseY);
    } else {
      Toast.hide();
      var errMsg = (response && response.error) || 'Unknown error';
      Toast.showScanError(errMsg, mouseX, mouseY);
    }
  });
}

function handleScanResult(result, mouseX, mouseY) {
  Toast.hide();

  if (result && result.text) {
    Toast.showScanSuccess(result.text, mouseX, mouseY);

    copyToClipboard(result.text).then(function (success) {
      if (!success) {
        Toast.showCopyFailed(mouseX, mouseY);
      }
    });

    detectAndNotifyURL(result.text);
  } else {
    Toast.showScanFailed(mouseX, mouseY);
  }
}

// ---------------------------------------------------------------------------
// URL 检测与自动打开
// ---------------------------------------------------------------------------

function detectAndNotifyURL(text) {
  if (!text) return null;

  var urlPattern = /^(https?:\/\/)?([\w\-]+\.)+[\w\-]+(\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?$/i;
  if (urlPattern.test(text.trim())) {
    var url = text.trim();
    if (!url.match(/^https?:\/\//i)) {
      url = 'https://' + url;
    }

    chrome.runtime.sendMessage({
      action: 'checkAndOpenURL',
      url: url
    });

    return url;
  }

  return null;
}

// ---------------------------------------------------------------------------
// 剪贴板复制
// ---------------------------------------------------------------------------

function copyToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(function () {
      return true;
    }).catch(function () {
      return fallbackCopy(text);
    });
  }
  return fallbackCopy(text);
}

function fallbackCopy(text) {
  return new Promise(function (resolve) {
    try {
      var textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      textarea.style.left = '-9999px';
      textarea.style.top = '-9999px';
      document.body.appendChild(textarea);
      textarea.select();
      var success = document.execCommand('copy');
      document.body.removeChild(textarea);
      resolve(success);
    } catch (err) {
      resolve(false);
    }
  });
}

// ---------------------------------------------------------------------------
// 消息监听（来自 Background 的消息）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  switch (message.action) {

    case 'displayQR':
      if (message.data && message.data.svg) {
        var toastX = message.mouseX || currentMouseX;
        var toastY = message.mouseY || currentMouseY;
        Toast.showGenerateSuccess(toastX, toastY);
        if (message.data.text) {
          copyToClipboard(message.data.text);
        }
      }
      sendResponse({ success: true });
      break;

    case 'scanResult':
      if (message.data && message.data.text) {
        Toast.showScanSuccess(message.data.text, currentMouseX, currentMouseY);
        copyToClipboard(message.data.text);
        detectAndNotifyURL(message.data.text);
      }
      sendResponse({ success: true });
      break;

    case 'scanFailed':
      Toast.hide();
      Toast.showScanFailed(currentMouseX, currentMouseY);
      sendResponse({ success: true });
      break;

    case 'showProgress':
      Toast.showScanning(currentMouseX, currentMouseY);
      sendResponse({ success: true });
      break;

    case 'showError':
      Toast.hide();
      Toast.show(message.error, currentMouseX, currentMouseY, 'error');
      sendResponse({ success: true });
      break;

    case 'copyToClipboard':
      if (message.text) {
        copyToClipboard(message.text).then(function (success) {
          sendResponse({ success: success });
        });
        return true;
      }
      sendResponse({ success: false });
      break;

    default:
      sendResponse({ success: false, error: 'Unknown action: ' + message.action });
      break;
  }
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

console.log('[QR Helper] Content script loaded');
