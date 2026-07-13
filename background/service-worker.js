/**
 * Background Service Worker v1.0.1
 *
 * 功能：
 * - 创建树状右键菜单（QR Helper 父菜单 + 子菜单项）
 * - 处理右键菜单点击事件（选中文本/页面 URL/链接/图片扫描）
 * - 调用 WASM 模块生成或扫描 QR 码
 * - 跨域图片获取代理（SW fetch 有 host_permissions，不受 CORS 限制）
 * - 与 Content Script 通信，传递扫描/生成结果
 * - 读取设置（URL 自动打开等）
 *
 * 加载顺序（通过 importScripts）：
 *   1. lib/zxing-wasm-full.js  → ZXingWASM 全局变量
 *   2. utils/zxing-loader.js   → QRModule 包装函数
 */

importScripts('../lib/zxing-wasm-full.js');
importScripts('../utils/zxing-loader.js');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

var MENU_IDS = {
  PARENT: 'qr-helper-parent',
  GENERATE_SELECTION: 'qr-generate-selection',
  GENERATE_PAGE: 'qr-generate-page',
  GENERATE_LINK: 'qr-generate-link',
  SCAN_IMAGE: 'qr-scan-image'
};

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
    chrome.contextMenus.create({ id: MENU_IDS.PARENT, title: chrome.i18n.getMessage('contextMenu_parent'), contexts: ['all'] });
    chrome.contextMenus.create({ id: MENU_IDS.GENERATE_SELECTION, parentId: MENU_IDS.PARENT, title: chrome.i18n.getMessage('contextMenu_generateSelection'), contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_IDS.GENERATE_PAGE, parentId: MENU_IDS.PARENT, title: chrome.i18n.getMessage('contextMenu_generatePage'), contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_IDS.GENERATE_LINK, parentId: MENU_IDS.PARENT, title: chrome.i18n.getMessage('contextMenu_generateLink'), contexts: ['link'] });
    chrome.contextMenus.create({ id: MENU_IDS.SCAN_IMAGE, parentId: MENU_IDS.PARENT, title: chrome.i18n.getMessage('contextMenu_scanImage'), contexts: ['image'] });
  });
}

// ---------------------------------------------------------------------------
// QR 扫描图片
// ---------------------------------------------------------------------------

/**
 * 从图片 URL 扫描 QR 码
 * SW 的 fetch() 凭 host_permissions 绕过 CORS，但请求携带 Sec-Fetch-Dest: empty，
 * 部分 CDN（如 file.cangku.moe）会因此拒绝返回图片。此类 CDN 目前无法扫描。
 */
async function scanImageFromUrl(imageUrl) {
  await QRModule.initQRModule();

  // 获取图片原始字节（Uint8Array）
  var response = await fetch(imageUrl, { credentials: 'include' });
  if (!response.ok) throw new Error('Failed to fetch image: HTTP ' + response.status);
  var buffer = await response.arrayBuffer();
  var bytes = new Uint8Array(buffer);

  // 传给 ZXing-WASM 扫描
  return await QRModule.readQR(bytes);
}

// ---------------------------------------------------------------------------
// QR 生成
// ---------------------------------------------------------------------------

async function generateQRCode(text) {
  await loadSettings();
  return await QRModule.generateQR(text, {
    scale: settingsCache.qrScale || 8,
    ecLevel: settingsCache.qrEcLevel || 'M'
  });
}

// ---------------------------------------------------------------------------
// URL 检测
// ---------------------------------------------------------------------------

function detectURL(text) {
  if (!text) return null;
  var urlPattern = /^(https?:\/\/)?([\w\-]+\.)+[\w\-]+(\/[\w\-._~:/?#[\]@!$&'()*+,;=]*)?$/i;
  if (urlPattern.test(text.trim())) {
    if (!text.match(/^https?:\/\//i)) return 'https://' + text.trim();
    return text.trim();
  }
  return null;
}

function handleAutoOpenURL(url, tabId) {
  if (!url) return;
  loadSettings().then(function () {
    if (!settingsCache.autoOpenUrl) return;
    if (settingsCache.openInNewTab) chrome.tabs.create({ url: url, active: true });
    else chrome.tabs.update(tabId, { url: url });
  });
}

// ---------------------------------------------------------------------------
// 安全发送消息到 Content Script
// ---------------------------------------------------------------------------

function sendToContentScriptSafe(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(function () {});
}

// ---------------------------------------------------------------------------
// 事件处理：右键菜单点击
// ---------------------------------------------------------------------------

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  loadSettings();

  (async function () {
    switch (info.menuItemId) {

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
            error: chrome.i18n.getMessage('toast_generateFailed', err.message)
          });
        }
        break;

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
            error: chrome.i18n.getMessage('toast_generateFailed', err.message)
          });
        }
        break;

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
            error: chrome.i18n.getMessage('toast_generateFailed', err.message)
          });
        }
        break;

      case MENU_IDS.SCAN_IMAGE:
        if (!info.srcUrl) return;
        await sendToContentScriptSafe(tab.id, {
          action: 'showProgress',
          message: chrome.i18n.getMessage('toast_scanning')
        });
        try {
          var result = await scanImageFromUrl(info.srcUrl);
          if (result && result.text) {
            await sendToContentScriptSafe(tab.id, {
              action: 'scanResult',
              data: { text: result.text, format: result.format }
            });
            try { await sendToContentScriptSafe(tab.id, { action: 'copyToClipboard', text: result.text }); } catch (_) {}
            var detectedUrl = detectURL(result.text);
            if (detectedUrl) handleAutoOpenURL(detectedUrl, tab.id);
          } else {
            await sendToContentScriptSafe(tab.id, {
              action: 'scanFailed',
              message: chrome.i18n.getMessage('toast_scanFailed')
            });
          }
        } catch (err) {
          console.error('[QR Helper] scanImage error:', err);
          await sendToContentScriptSafe(tab.id, {
            action: 'showError',
            error: chrome.i18n.getMessage('toast_scanError', err.message)
          });
        }
        break;
    }
  })();
});

// ---------------------------------------------------------------------------
// 消息监听（来自 Content Script）
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  switch (message.action) {

    case 'fetchAndScanImage':
      scanImageFromUrl(message.imageUrl)
        .then(function (result) { sendResponse({ success: true, result: result }); })
        .catch(function (err) { sendResponse({ success: false, error: err.message }); });
      return true;

    case 'getSettings':
      loadSettings().then(function () { sendResponse(settingsCache); });
      return true;

    default:
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
  console.log('[QR Helper v1.0.1] Installed:', details.reason);
  createContextMenus();
  loadSettings();
  QRModule.initQRModule().then(function () {
    console.log('[QR Helper] WASM module ready');
  }).catch(function (err) {
    console.error('[QR Helper] WASM init failed:', err);
  });
});

loadSettings();
QRModule.initQRModule().catch(function (err) {
  console.warn('[QR Helper] Initial WASM init:', err.message);
});
