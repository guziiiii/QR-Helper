/**
 * 设置页面脚本 — options.js
 *
 * 功能：
 * - 读取 chrome.storage.sync 中的设置并填充表单
 * - 保存设置到 chrome.storage.sync
 * - 通过 chrome.i18n.getMessage() 渲染所有 UI 文案
 *
 * 依赖：options.html（在 chrome-extension:// 页面中运行）
 */

// ---------------------------------------------------------------------------
// 设置默认值
// ---------------------------------------------------------------------------

/** 所有设置项的默认值 */
var DEFAULTS = {
  enableLongPress: true,  // 启用长按扫描
  autoOpenUrl: false,    // 检测到 URL 时自动打开
  openInNewTab: true,    // 是否在新标签页打开
  qrScale: 8,            // QR 模块像素大小
  qrEcLevel: 'M'         // 纠错等级 L / M / Q / H
};

// ---------------------------------------------------------------------------
// DOM 元素引用（初始化时填充）
// ---------------------------------------------------------------------------

var elements = {};

/**
 * 缓存 DOM 元素引用
 */
function cacheElements() {
  elements = {
    pageTitle: document.getElementById('page-title'),
    enableLongPress: document.getElementById('enable-long-press'),
    labelLongPress: document.getElementById('label-enable-long-press'),
    labelAutoOpen: document.getElementById('label-auto-open'),
    autoOpenUrl: document.getElementById('auto-open-url'),
    labelAutoOpenUrl: document.getElementById('label-auto-open-url'),
    openMethodSection: document.getElementById('open-method-section'),
    openNewTab: document.getElementById('open-new-tab'),
    labelOpenNewTab: document.getElementById('label-open-new-tab'),
    openCurrentTab: document.getElementById('open-current-tab'),
    labelOpenCurrentTab: document.getElementById('label-open-current-tab'),
    saveButton: document.getElementById('save-button'),
    saveStatus: document.getElementById('save-status')
  };
}

// ---------------------------------------------------------------------------
// I18N 文案渲染
// ---------------------------------------------------------------------------

/**
 * 使用 chrome.i18n.getMessage() 填充所有 UI 文案
 */
function localizeUI() {
  if (elements.pageTitle) {
    elements.pageTitle.textContent = chrome.i18n.getMessage('options_title');
  }
  if (elements.labelLongPress) {
    elements.labelLongPress.textContent = chrome.i18n.getMessage('popup_enableLongPress');
  }
  if (elements.labelAutoOpen) {
    elements.labelAutoOpen.textContent = chrome.i18n.getMessage('options_autoOpenUrl');
  }
  if (elements.labelAutoOpenUrl) {
    elements.labelAutoOpenUrl.textContent = chrome.i18n.getMessage('options_autoOpenUrl');
  }
  if (elements.labelOpenNewTab) {
    elements.labelOpenNewTab.textContent = chrome.i18n.getMessage('options_openInNewTab');
  }
  if (elements.labelOpenCurrentTab) {
    elements.labelOpenCurrentTab.textContent = chrome.i18n.getMessage('options_openInCurrentTab');
  }
  if (elements.saveButton) {
    elements.saveButton.textContent = chrome.i18n.getMessage('options_saveButton');
  }
}

// ---------------------------------------------------------------------------
// 设置读写
// ---------------------------------------------------------------------------

/**
 * 从 chrome.storage.sync 加载设置并填充表单
 */
function loadSettings() {
  chrome.storage.sync.get(null, function (items) {
    // 合并默认值
    var settings = {};
    for (var key in DEFAULTS) {
      if (DEFAULTS.hasOwnProperty(key)) {
        settings[key] = (items[key] !== undefined) ? items[key] : DEFAULTS[key];
      }
    }

    // 填充表单
    elements.enableLongPress.checked = settings.enableLongPress === true;
    elements.autoOpenUrl.checked = settings.autoOpenUrl === true;

    if (settings.openInNewTab === true) {
      elements.openNewTab.checked = true;
    } else {
      elements.openCurrentTab.checked = true;
    }

    // 根据 autoOpenUrl 的选中状态控制打开方式子选项的可见性
    toggleOpenMethodVisibility(settings.autoOpenUrl === true);
  });
}

/**
 * 保存设置到 chrome.storage.sync
 */
function saveSettings() {
  // 从表单读取值
  var settings = {
    enableLongPress: elements.enableLongPress.checked,
    autoOpenUrl: elements.autoOpenUrl.checked,
    openInNewTab: elements.openNewTab.checked
  };

  // 保存到 storage.sync
  chrome.storage.sync.set(settings, function () {
    // 显示保存成功提示
    showSaveSuccess();
  });
}

// ---------------------------------------------------------------------------
// 子选项可见性控制
// ---------------------------------------------------------------------------

/**
 * 根据"自动打开 URL"的选中状态，显示或隐藏打开方式子选项
 *
 * @param {boolean} visible - 是否可见
 */
function toggleOpenMethodVisibility(visible) {
  if (elements.openMethodSection) {
    elements.openMethodSection.style.display = visible ? 'block' : 'none';
  }
}

// ---------------------------------------------------------------------------
// 保存成功提示
// ---------------------------------------------------------------------------

/** 保存成功提示的定时器 */
var saveStatusTimer = null;

/**
 * 显示保存成功提示（3 秒后自动消失）
 */
function showSaveSuccess() {
  var statusEl = elements.saveStatus;
  if (!statusEl) return;

  // 设置文案
  statusEl.textContent = chrome.i18n.getMessage('options_saveSuccess');

  // 显示
  statusEl.classList.add('visible');

  // 清除之前的定时器
  if (saveStatusTimer) {
    clearTimeout(saveStatusTimer);
  }

  // 3 秒后自动隐藏
  saveStatusTimer = setTimeout(function () {
    statusEl.classList.remove('visible');
    saveStatusTimer = null;
  }, 3000);
}

// ---------------------------------------------------------------------------
// 事件绑定
// ---------------------------------------------------------------------------

/**
 * 绑定所有事件监听
 */
function bindEvents() {
  // 保存按钮点击
  if (elements.saveButton) {
    elements.saveButton.addEventListener('click', saveSettings);
  }

  // "启用长按扫描" 复选框
  if (elements.enableLongPress) {
    elements.enableLongPress.addEventListener('change', saveSettings);
  }

  // "自动打开 URL" 复选框：控制子选项显示
  if (elements.autoOpenUrl) {
    elements.autoOpenUrl.addEventListener('change', function () {
      toggleOpenMethodVisibility(this.checked);
    });
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

/**
 * 页面加载完成后初始化
 */
function init() {
  // 缓存 DOM 引用
  cacheElements();

  // 渲染 I18N 文案
  localizeUI();

  // 加载设置
  loadSettings();

  // 绑定事件
  bindEvents();
}

// DOM 加载完成后初始化
document.addEventListener('DOMContentLoaded', init);
