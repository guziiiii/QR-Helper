/**
 * Background Service Worker
 *
 * 功能：
 * - 创建树状右键菜单（QR Helper 父菜单 + 子菜单项）
 * - 处理右键菜单点击事件（选中文本/页面 URL/链接/图片扫描）
 * - 调用 WASM 模块生成或扫描 QR 码
 * - 跨域图片获取代理（SW fetch 无 CORS 限制）
 * - 与 Content Script 通信，传递扫描/生成结果
 * - 读取设置（URL 自动打开等）
 *
 * 加载顺序（通过 importScripts）：
 *   1. lib/zxing-wasm-full.js  → ZXingWASM 全局变量
 *   2. utils/zxing-loader.js   → QRModule 包装函数
 */

// 在 Service Worker 中加载 ZXing-WASM 和加载器
importScripts('../lib/zxing-wasm-full.js');
importScripts('../utils/zxing-loader.js');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 右键菜单 ID 常量 */
var MENU_IDS = {
  PARENT: 'qr-helper-parent',
  GENERATE_SELECTION: 'qr-generate-selection',
  GENERATE_PAGE: 'qr-generate-page',
  GENERATE_LINK: 'qr-generate-link',
  SCAN_IMAGE: 'qr-scan-image'
};

/** 扫描超时（毫秒） */
var SCAN_TIMEOUT = 15000;

// ---------------------------------------------------------------------------
// 设置缓存
// ---------------------------------------------------------------------------

var settingsCache = {
  autoOpenUrl: false,
  openInNewTab: true,
  qrScale: 8,
  qrEcLevel: 'M'
};

var settingsInitPromise = null;

function loadSettings() {
  if (settingsInitPromise) return settingsInitPromise;

  settingsInitPromise = chrome.storage.sync.get(null).then(function (items) {
    if (items.autoOpenUrl !== undefined) settingsCache.autoOpenUrl = items.autoOpenUrl;
    if (items.openInNewTab !== undefined) settingsCache.openInNewTab = items.openInNewTab;
    if (items.qrScale !== undefined) settingsCache.qrScale = items.qrScale;
    if (items.qrEcLevel !== undefined) settingsCache.qrEcLevel = items.qrEcLevel;
    return settingsCache;
  });

  return settingsInitPromise;
}

// ---------------------------------------------------------------------------
// 右键菜单管理
// ---------------------------------------------------------------------------

function createContextMenus() {
  chrome.contextMenus.removeAll(function () {
    chrome.contextMenus.create({
      id: MENU_IDS.PARENT,
      title: chrome.i18n.getMessage('contextMenu_parent'),
      contexts: ['all']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.GENERATE_SELECTION,
      parentId: MENU_IDS.PARENT,
      title: chrome.i18n.getMessage('contextMenu_generateSelection'),
      contexts: ['selection']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.GENERATE_PAGE,
      parentId: MENU_IDS.PARENT,
      title: chrome.i18n.getMessage('contextMenu_generatePage'),
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.GENERATE_LINK,
      parentId: MENU_IDS.PARENT,
      title: chrome.i18n.getMessage('contextMenu_generateLink'),
      contexts: ['link']
    });
    chrome.contextMenus.create({
      id: MENU_IDS.SCAN_IMAGE,
      parentId: MENU_IDS.PARENT,
      title: chrome.i18n.getMessage('contextMenu_scanImage'),
      contexts: ['image']
    });
  });
}

// ---------------------------------------------------------------------------
// QR 扫描图片
// ---------------------------------------------------------------------------

/**
 * 从图片 URL 扫描 QR 码（带超时）
 *
 * @param {string} imageUrl - 图片 URL
 * @param {string} [pageOrigin] - 嵌入图片的页面 origin（用于 Referer 反盗链）
 */
async function scanImageFromUrl(imageUrl, pageOrigin) {
  // 确保 WASM 模块已初始化
  await QRModule.initQRModule();

  // 创建一个超时 Promise
  var timeoutPromise = new Promise(function (_, reject) {
    setTimeout(function () {
      reject(new Error('Scan timed out after ' + (SCAN_TIMEOUT / 1000) + 's'));
    }, SCAN_TIMEOUT);
  });

  // 实际扫描 Promise
  var scanPromise = (async function () {
    var blob = await QRModule.fetchImageAsBlob(imageUrl, pageOrigin);
    var result = await QRModule.readQR(blob);
    return result;
  })();

  // 谁先返回就用谁
  return await Promise.race([scanPromise, timeoutPromise]);
}

// ---------------------------------------------------------------------------
// QR 生成
// ---------------------------------------------------------------------------

async function generateQRCode(text) {
  await loadSettings();
  var options = {
    scale: settingsCache.qrScale || 8,
    ecLevel: settingsCache.qrEcLevel || 'M'
  };
  return await QRModule.generateQR(text, options);
}

// ---------------------------------------------------------------------------
// URL 检测
// ---------------------------------------------------------------------------

function detectURL(text) {
  if (!text) return null;
  var urlPattern = /^(https?:\/\/)?([\w\-]+\.)+[\w\-]+(\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?$/i;
  if (urlPattern.test(text.trim())) {
    if (!text.match(/^https?:\/\//i)) {
      return 'https://' + text.trim();
    }
    return text.trim();
  }
  return null;
}

function handleAutoOpenURL(url, tabId) {
  if (!url) return;
  loadSettings().then(function () {
    if (!settingsCache.autoOpenUrl) return;
    if (settingsCache.openInNewTab) {
      chrome.tabs.create({ url: url, active: true });
    } else {
      chrome.tabs.update(tabId, { url: url });
    }
  });
}

// ---------------------------------------------------------------------------
// 事件处理：右键菜单点击（async 防止 SW 提前终止）
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  loadSettings();

  // 使用立即执行的 async 函数确保 Promise 链被 SW 跟踪
  (async function () {
    switch (info.menuItemId) {

      // 生成 QR：选中文本
      case MENU_IDS.GENERATE_SELECTION:
        if (!info.selectionText) return;
        try {
          var qrResult = await generateQRCode(info.selectionText);
          await sendToContentScriptSafe(tab.id, {
            action: 'displayQR',
            data: { svg: qrResult.svg, text: info.selectionText, type: 'selection' }
          });
        } catch (err) {
          await sendToContentScriptSafe(tab.id, {
            action: 'showError',
            error: chrome.i18n.getMessage('toast_generateFailed', err.message || 'Unknown error')
          });
        }
        break;

      // 生成 QR：页面 URL
      case MENU_IDS.GENERATE_PAGE:
        if (!info.pageUrl) return;
        try {
          var qrResult = await generateQRCode(info.pageUrl);
          await sendToContentScriptSafe(tab.id, {
            action: 'displayQR',
            data: { svg: qrResult.svg, text: info.pageUrl, type: 'pageUrl' }
          });
        } catch (err) {
          await sendToContentScriptSafe(tab.id, {
            action: 'showError',
            error: chrome.i18n.getMessage('toast_generateFailed', err.message || 'Unknown error')
          });
        }
        break;

      // 生成 QR：链接 URL
      case MENU_IDS.GENERATE_LINK:
        if (!info.linkUrl) return;
        try {
          var qrResult = await generateQRCode(info.linkUrl);
          await sendToContentScriptSafe(tab.id, {
            action: 'displayQR',
            data: { svg: qrResult.svg, text: info.linkUrl, type: 'linkUrl' }
          });
        } catch (err) {
          await sendToContentScriptSafe(tab.id, {
            action: 'showError',
            error: chrome.i18n.getMessage('toast_generateFailed', err.message || 'Unknown error')
          });
        }
        break;

      // 扫描 QR：从图片
      case MENU_IDS.SCAN_IMAGE:
        if (!info.srcUrl) return;

        // 先通知 Content Script 显示"扫描中"
        await sendToContentScriptSafe(tab.id, {
          action: 'showProgress',
          message: chrome.i18n.getMessage('toast_scanning')
        });

        try {
          // 从 tab.url 提取嵌入页面的 origin 作为 Referer（绕过 CDN 反盗链）
          var pageOrigin = '';
          if (tab && tab.url) {
            try { pageOrigin = new URL(tab.url).origin; } catch (_) {}
          }
          var result = await scanImageFromUrl(info.srcUrl, pageOrigin);

          if (result && result.text) {
            // 扫描成功
            await sendToContentScriptSafe(tab.id, {
              action: 'scanResult',
              data: { text: result.text, format: result.format }
            });

            // 复制到剪贴板
            try {
              await sendToContentScriptSafe(tab.id, {
                action: 'copyToClipboard',
                text: result.text
              });
            } catch (_) { /* 复制失败不中断流程 */ }

            // 自动打开 URL
            var detectedUrl = detectURL(result.text);
            if (detectedUrl) {
              handleAutoOpenURL(detectedUrl, tab.id);
            }
          } else {
            // 未找到 QR 码
            await sendToContentScriptSafe(tab.id, {
              action: 'scanFailed',
              message: chrome.i18n.getMessage('toast_scanFailed')
            });
          }
        } catch (err) {
          console.error('[QR Helper] scanImage error:', err);
          await sendToContentScriptSafe(tab.id, {
            action: 'showError',
            error: chrome.i18n.getMessage('toast_scanError', err.message || 'Unknown error')
          });
        }
        break;
    }
  })();
});

// ---------------------------------------------------------------------------
// 安全发送消息到 Content Script（失败不抛异常）
// ---------------------------------------------------------------------------

function sendToContentScriptSafe(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(function () {
    // Content Script 可能尚未注入，静默忽略
  });
}

// ---------------------------------------------------------------------------
// 消息监听（来自 Content Script 的请求）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  switch (message.action) {

    // Content Script 请求：扫描跨域图片
    case 'fetchAndScanImage':
      (function () {
        var imgUrl = message.imageUrl;
        var refOrigin = message.pageOrigin || '';
        scanImageFromUrl(imgUrl, refOrigin)
          .then(function (result) {
            sendResponse({ success: true, result: result });
          })
          .catch(function (err) {
            sendResponse({ success: false, error: err.message });
          });
      })();
      return true; // async

    // Content Script 请求：获取设置
    case 'getSettings':
      loadSettings().then(function () {
        sendResponse(settingsCache);
      });
      return true; // async

    default:
      sendResponse({ success: false, error: 'Unknown action: ' + message.action });
      break;
  }
});

// ---------------------------------------------------------------------------
// 设置变更监听
// ---------------------------------------------------------------------------

chrome.storage.onChanged.addListener(function (changes, areaName) {
  if (areaName === 'sync') {
    for (var key in changes) {
      if (changes.hasOwnProperty(key) && key in settingsCache) {
        settingsCache[key] = changes[key].newValue;
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener(function (details) {
  console.log('[QR Helper] Extension installed/updated:', details.reason);
  createContextMenus();
  loadSettings();
  QRModule.initQRModule().then(function () {
    console.log('[QR Helper] WASM module ready in service worker');
  }).catch(function (err) {
    console.error('[QR Helper] WASM initialization failed:', err);
  });
});

// 启动时初始化
loadSettings();
QRModule.initQRModule().catch(function (err) {
  console.warn('[QR Helper] Initial WASM init:', err.message);
});
