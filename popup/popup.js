/**
 * Popup 设置面板 — 实时保存，无需按钮
 *
 * 所有控件 onchange 立即写入 chrome.storage.sync
 * 打开时从 chrome.storage.sync 加载当前值填充
 */

document.addEventListener('DOMContentLoaded', function () {
  // DOM 元素引用
  var els = {
    enableLongPress: document.getElementById('enable-long-press'),
    labelLongPress: document.getElementById('label-enable-long-press'),
    autoOpenUrl: document.getElementById('auto-open-url'),
    labelAutoOpenUrl: document.getElementById('label-auto-open-url'),
    openMethodSection: document.getElementById('open-method-section'),
    openNewTab: document.getElementById('open-new-tab'),
    labelOpenNewTab: document.getElementById('label-open-new-tab'),
    openCurrentTab: document.getElementById('open-current-tab'),
    labelOpenCurrentTab: document.getElementById('label-open-current-tab')
  };

  // ---- I18N 渲染 ----
  document.getElementById('popup-title').textContent =
    chrome.i18n.getMessage('appName');
  els.labelLongPress.textContent =
    chrome.i18n.getMessage('popup_enableLongPress');
  els.labelAutoOpenUrl.textContent =
    chrome.i18n.getMessage('options_autoOpenUrl');
  els.labelOpenNewTab.textContent =
    chrome.i18n.getMessage('options_openInNewTab');
  els.labelOpenCurrentTab.textContent =
    chrome.i18n.getMessage('options_openInCurrentTab');

  // ---- 设置默认值 ----
  var DEFAULTS = {
    enableLongPress: true,
    autoOpenUrl: false,
    openInNewTab: true
  };

  // ---- 从 storage 加载设置并填充表单 ----
  chrome.storage.sync.get(null, function (items) {
    var enableLongPress = items.enableLongPress !== undefined
      ? items.enableLongPress : DEFAULTS.enableLongPress;
    var autoOpenUrl = items.autoOpenUrl !== undefined
      ? items.autoOpenUrl : DEFAULTS.autoOpenUrl;
    var openInNewTab = items.openInNewTab !== undefined
      ? items.openInNewTab : DEFAULTS.openInNewTab;

    els.enableLongPress.checked = enableLongPress;
    els.autoOpenUrl.checked = autoOpenUrl;
    els.openNewTab.checked = openInNewTab === true;
    els.openCurrentTab.checked = openInNewTab !== true;

    toggleOpenMethodVisibility(autoOpenUrl);
  });

  // ---- 实时保存函数 ----
  function saveSetting(key, value) {
    var obj = {};
    obj[key] = value;
    chrome.storage.sync.set(obj);
  }

  // ---- 子选项可见性 ----
  function toggleOpenMethodVisibility(visible) {
    els.openMethodSection.style.display = visible ? 'block' : 'none';
  }

  // ---- 事件绑定 ----
  // 长按扫描开关
  els.enableLongPress.addEventListener('change', function () {
    saveSetting('enableLongPress', this.checked);
  });

  // 自动打开 URL 开关
  els.autoOpenUrl.addEventListener('change', function () {
    saveSetting('autoOpenUrl', this.checked);
    toggleOpenMethodVisibility(this.checked);
  });

  // 打开方式：新标签
  els.openNewTab.addEventListener('change', function () {
    if (this.checked) {
      saveSetting('openInNewTab', true);
    }
  });

  // 打开方式：当前标签
  els.openCurrentTab.addEventListener('change', function () {
    if (this.checked) {
      saveSetting('openInNewTab', false);
    }
  });
});
