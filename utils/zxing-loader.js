/**
 * WASM 加载器模块 — ZXing-WASM 的加载与统一封装
 *
 * 功能：
 * - 自动检测运行环境（Content Script vs Service Worker）
 * - 使用对应策略加载 WASM 二进制文件
 * - 提供统一的 readQR / generateQR 包装函数
 *
 * 使用方式：
 *   // Content Script 中：ZXingWASM 由 manifest 的 content_scripts.js 自动注入
 *   // Service Worker 中：在 service-worker.js 顶部调用 importScripts() 加载
 *   // 然后调用 initQRModule() 初始化，再使用 readQR / generateQR
 */

// ---------------------------------------------------------------------------
// 环境检测
// ---------------------------------------------------------------------------

/** 当前是否运行在 Service Worker 中（无 window/document） */
const isServiceWorker = typeof window === 'undefined';

/** 当前是否运行在 Content Script 或 Options Page 中 */
const isExtensionPage = !isServiceWorker && typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id;

// ---------------------------------------------------------------------------
// 初始化标记
// ---------------------------------------------------------------------------

let moduleInitialized = false;
let initPromise = null;

// ---------------------------------------------------------------------------
// 默认 Reader/Writer 选项
// ---------------------------------------------------------------------------

/** QR 扫描默认选项 */
const DEFAULT_READER_OPTIONS = {
  formats: ['QRCode'],
  tryHarder: true,
  tryRotate: true,
  tryInvert: true,
  tryDownscale: true,
  tryDenoise: false,
  maxNumberOfSymbols: 1
};

/** QR 生成默认选项 */
const DEFAULT_WRITER_OPTIONS = {
  format: 'QRCode',
  scale: 8,
  options: 'ecLevel=M'
};

// ---------------------------------------------------------------------------
// WASM 文件定位
// ---------------------------------------------------------------------------

/**
 * 获取 WASM 文件的完整 URL（基于当前扩展路径）
 * 在 Content Script 和 Service Worker 中均有效
 */
function getWasmUrl() {
  // chrome.runtime.getURL 在 Content Script 和 Service Worker 中均可使用
  return chrome.runtime.getURL('wasm/zxing_full.wasm');
}

// ---------------------------------------------------------------------------
// Content Script 环境的 WASM 初始化
// ---------------------------------------------------------------------------

/**
 * 在 Content Script 中初始化 WASM 模块
 * 使用 locateFile 策略：库默认从 CDN 加载，我们重定向到扩展内部文件
 */
function initContentScriptWasm() {
  // ZXingWASM 应已在全局作用域中（由 manifest 中 content_scripts 的 js 顺序加载）
  if (typeof ZXingWASM === 'undefined') {
    console.error('[QR Helper] ZXingWASM library not loaded. Check manifest content_scripts ordering.');
    return Promise.reject(new Error('ZXingWASM not loaded'));
  }

  try {
    // 配置 WASM 文件加载路径：指向扩展内部的 wasm 文件
    ZXingWASM.prepareZXingModule({
      overrides: {
        locateFile: function (path, prefix) {
          if (path.endsWith('.wasm')) {
            return chrome.runtime.getURL('wasm/' + path);
          }
          return prefix + path;
        }
      },
      fireImmediately: false // 默认惰性加载，首次调用 read/write 时触发
    });
    return Promise.resolve();
  } catch (err) {
    console.error('[QR Helper] Failed to configure ZXingWASM:', err);
    return Promise.reject(err);
  }
}

// ---------------------------------------------------------------------------
// Service Worker 环境的 WASM 初始化
// ---------------------------------------------------------------------------

/**
 * 在 Service Worker 中初始化 WASM 模块
 * 使用 wasmBinary 策略：先 fetch 整个 .wasm 文件的二进制内容，
 * 然后通过 wasmBinary / instantiateWasm 注入到 Emscripten 模块
 */
async function initServiceWorkerWasm() {
  // ZXingWASM 应已在全局作用域中（由 service-worker.js 顶部的 importScripts 加载）
  if (typeof ZXingWASM === 'undefined') {
    console.error('[QR Helper] ZXingWASM library not loaded. Check importScripts in service worker.');
    return Promise.reject(new Error('ZXingWASM not loaded'));
  }

  try {
    // 获取 WASM 文件路径
    const wasmUrl = getWasmUrl();

    // fetch 整个 .wasm 文件的 ArrayBuffer，通过 wasmBinary 注入
    // 注意：不同时设置 instantiateWasm，避免覆盖 Emscripten 默认实例化逻辑
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error('Failed to fetch WASM binary: ' + response.status);
    }
    const wasmBuffer = await response.arrayBuffer();

    // 仅设置 wasmBinary，Emscripten 自动使用它实例化
    await ZXingWASM.prepareZXingModule({
      overrides: {
        wasmBinary: wasmBuffer
      },
      fireImmediately: true
    });
  } catch (err) {
    console.error('[QR Helper] Failed to initialize WASM in Service Worker:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 初始化入口
// ---------------------------------------------------------------------------

/**
 * 初始化 QR 模块（WASM 加载与配置）
 * 可在扩展启动时尽早调用，以预热 WASM 模块
 *
 * @returns {Promise<void>}
 */
function initQRModule() {
  if (moduleInitialized) {
    return Promise.resolve();
  }
  if (initPromise) {
    return initPromise;
  }

  if (isServiceWorker) {
    initPromise = initServiceWorkerWasm();
  } else {
    initPromise = initContentScriptWasm();
  }

  return initPromise.then(function () {
    moduleInitialized = true;
    console.log('[QR Helper] ZXing-WASM module initialized (' +
      (isServiceWorker ? 'Service Worker' : 'Content Script') + ')');
  });
}

// ---------------------------------------------------------------------------
// QR 扫描（解码）
// ---------------------------------------------------------------------------

/**
 * 从图片数据中扫描 QR 码
 *
 * @param {Blob|File|ArrayBuffer|Uint8Array|ImageData} imageInput - 图片输入
 * @param {Object} [options] - 扫描选项（会与默认值合并）
 * @param {string[]} [options.formats] - 扫描格式
 * @param {boolean} [options.tryHarder] - 是否尝试更深入的搜索
 * @returns {Promise<{text: string, format: string, position: Object}|null>}
 *   返回解码结果，未找到 QR 码时返回 null
 */
async function readQR(imageInput, options) {
  // 确保 WASM 已初始化
  if (!moduleInitialized) {
    await initQRModule();
  }

  const readerOptions = Object.assign({}, DEFAULT_READER_OPTIONS, options || {});

  try {
    // 调用 ZXing-WASM 的 readBarcodes
    const results = await ZXingWASM.readBarcodes(imageInput, readerOptions);

    // ZXing 返回数组，无匹配时返回空数组
    if (results && results.length > 0) {
      const result = results[0];
      return {
        text: result.text,
        format: result.format,
        position: result.position,
        bytes: result.bytes,
        isValid: result.isValid
      };
    }

    return null; // 未找到 QR 码
  } catch (err) {
    console.error('[QR Helper] readQR error:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// QR 生成（编码）
// ---------------------------------------------------------------------------

/**
 * 生成 QR 码
 *
 * @param {string} text - 要编码的文本内容
 * @param {Object} [options] - 生成选项
 * @param {number} [options.scale] - 每个模块的像素大小
 * @param {string} [options.ecLevel] - 纠错等级 L / M / Q / H
 * @param {boolean} [options.returnImageBlob] - 是否返回 PNG Blob（默认仅返回 SVG）
 * @returns {Promise<{svg: string, image: Blob|null}>}
 *   返回 SVG 字符串和可选的 PNG Blob
 */
async function generateQR(text, options) {
  // 确保 WASM 已初始化
  if (!moduleInitialized) {
    await initQRModule();
  }

  const writerOptions = Object.assign({}, DEFAULT_WRITER_OPTIONS);

  // 合并用户选项
  if (options) {
    if (options.scale !== undefined) writerOptions.scale = options.scale;
    if (options.ecLevel !== undefined) {
      writerOptions.options = 'ecLevel=' + options.ecLevel;
    }
    if (options.format !== undefined) writerOptions.format = options.format;
  }

  // 参数校验
  if (!text || typeof text !== 'string') {
    throw new Error('Text to encode is required');
  }

  try {
    // 调用 ZXing-WASM 的 writeBarcode
    const writeResult = await ZXingWASM.writeBarcode(text, writerOptions);

    return {
      svg: writeResult.svg,
      image: writeResult.image // PNG Blob
    };
  } catch (err) {
    console.error('[QR Helper] generateQR error:', err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

var QRModule = {
  initQRModule: initQRModule,
  readQR: readQR,
  generateQR: generateQR,
  getWasmUrl: getWasmUrl,
  isServiceWorker: isServiceWorker,
  isExtensionPage: isExtensionPage
};
