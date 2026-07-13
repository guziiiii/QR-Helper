/**
 * Background Service Worker v1.1.0
 *
 * 功能：
 * - 创建树状右键菜单（QR Helper 父菜单 + 子菜单项）
 * - 处理右键菜单点击事件（选中文本/页面 URL/链接/图片扫描）
 * - 调用 WASM 模块生成或扫描 QR 码
 * - 跨域图片获取代理：使用 chrome.debugger CDP Network.loadNetworkResource
 *   以浏览器完整网络栈加载图片（Sec-Fetch-Dest: image），绕过 CDN 反盗链
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
// CDP 图片获取 — 使用 chrome.debugger 的 Network.loadNetworkResource
// 通过浏览器完整网络栈请求图片，天然附带 Sec-Fetch-Dest: image
// ---------------------------------------------------------------------------

/**
 * 通过 CDP 从指定 tab 加载图片资源
 * 以该 tab 的浏览器上下文发出请求（带正确 cookies、headers、Sec-Fetch-* 头）
 *
 * @param {string} imageUrl - 图片 URL
 * @param {number} tabId - 标签页 ID
 * @returns {Promise<Uint8Array>} 图片的原始字节
 */
async function fetchImageViaCDP(imageUrl, tabId) {
  // attach debugger 到目标 tab
  await chrome.debugger.attach({ tabId: tabId }, '1.3');

  // 加载图片资源（返回 IO.StreamHandle）
  var result;
  try {
    result = await chrome.debugger.sendCommand(
      { tabId: tabId },
      'Network.loadNetworkResource',
      {
        url: imageUrl,
        options: {
          disableCache: false,
          includeCredentials: true
        }
      }
    );
  } catch (err) {
    await chrome.debugger.detach({ tabId: tabId });
    throw err;
  }

  if (!result || !result.resource || !result.resource.success) {
    await chrome.debugger.detach({ tabId: tabId });
    var errMsg = (result && result.resource && result.resource.netError)
      ? 'Network error: ' + result.resource.netError
      : 'CDP load failed';
    throw new Error(errMsg);
  }

  // 通过 IO 域读取 stream 内容
  var streamHandle = result.resource.stream;
  if (!streamHandle) {
    await chrome.debugger.detach({ tabId: tabId });
    throw new Error('CDP returned no stream handle');
  }

  var chunks = [];
  var isBase64 = false;
  try {
    while (true) {
      var readResult = await chrome.debugger.sendCommand(
        { tabId: tabId },
        'IO.read',
        { handle: streamHandle }
      );
      if (readResult.data) {
        chunks.push(readResult.data);
        if (readResult.base64Encoded) isBase64 = true;
      }
      if (readResult.eof) break;
    }
  } finally {
    try { await chrome.debugger.sendCommand({ tabId: tabId }, 'IO.close', { handle: streamHandle }); } catch (_) {}
    await chrome.debugger.detach({ tabId: tabId });
  }

  var raw;
  if (isBase64) {
    var base64 = chunks.join('');
    var binary = atob(base64);
    raw = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) raw[i] = binary.charCodeAt(i);
  } else {
    raw = new TextEncoder().encode(chunks.join(''));
  }

  return raw;
}

// ---------------------------------------------------------------------------
// QR 扫描图片
// ---------------------------------------------------------------------------

/**
 * 从图片 URL 扫描 QR 码
 * 使用 CDP 获取图片字节，避免 CDN 反盗链拦截
 *
 * @param {string} imageUrl - 图片 URL
 * @param {number} tabId - 标签页 ID（用于 CDP attach）
 */
async function scanImageFromUrl(imageUrl, tabId) {
  await QRModule.initQRModule();

  var timeoutPromise = new Promise(function (_, reject) {
    setTimeout(function () {
      reject(new Error('Scan timed out after ' + (SCAN_TIMEOUT / 1000) + 's'));
    }, SCAN_TIMEOUT);
  });

  var scanPromise = (async function () {
    // 使用 CDP 获取图片原始字节
    var imageBytes = await fetchImageViaCDP(imageUrl, tabId);
    // 传给 ZXing-WASM 扫描（接受 Uint8Array 格式的图片）
    var result = await QRModule.readQR(imageBytes);
    return result;
  })();

  return await Promise.race([scanPromise, timeoutPromise]);
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
            error: chrome.i18n.getMessage('toast_generateFailed', err.message || 'Unknown error')
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
            error: chrome.i18n.getMessage('toast_generateFailed', err.message || 'Unknown error')
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
            error: chrome.i18n.getMessage('toast_generateFailed', err.message || 'Unknown error')
          });
        }
        break;

      // 扫描 QR：从图片（使用 tab.id 挂载 CDP）
      case MENU_IDS.SCAN_IMAGE:
        if (!info.srcUrl) return;
        await sendToContentScriptSafe(tab.id, {
          action: 'showProgress',
          message: chrome.i18n.getMessage('toast_scanning')
        });
        try {
          var result = await scanImageFromUrl(info.srcUrl, tab.id);

          if (result && result.text) {
            await sendToContentScriptSafe(tab.id, {
              action: 'scanResult',
              data: { text: result.text, format: result.format }
            });
            try {
              await sendToContentScriptSafe(tab.id, {
                action: 'copyToClipboard',
                text: result.text
              });
            } catch (_) {}
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
            error: chrome.i18n.getMessage('toast_scanError', err.message || 'Unknown error')
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

    // Content Script 请求：扫描跨域图片
    // sender.tab.id 来自发起消息的标签页
    case 'fetchAndScanImage':
      (function () {
        var tabId = message.tabId || (sender && sender.tab && sender.tab.id);
        if (!tabId) {
          sendResponse({ success: false, error: 'No tabId available' });
          return;
        }
        scanImageFromUrl(message.imageUrl, tabId)
          .then(function (result) {
            sendResponse({ success: true, result: result });
          })
          .catch(function (err) {
            sendResponse({ success: false, error: err.message });
          });
      })();
      return true;

    case 'getSettings':
      loadSettings().then(function () {
        sendResponse(settingsCache);
      });
      return true;

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
  console.log('[QR Helper v1.1.0] Installed:', details.reason);
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
