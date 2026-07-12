# QR Helper — Chrome 扩展

扫描和生成二维码的 Chrome 扩展。

## 功能

- **长按图片扫描**：长按任意网页中的图片 600ms，自动扫描其中的 QR 码
- **右键菜单生成**：从选中文本、页面 URL、链接 URL 生成 QR 码
- **右键扫描图片**：右键图片 → QR Helper → 扫描 QR 码
- **剪贴板复制**：扫描结果自动复制到剪贴板
- **URL 自动打开**：检测到二维码内容为 URL 时可选自动打开
- **弹出设置面板**：工具栏图标弹出设置，实时保存
- **国际化**：简体中文 / English

## 加载方式

1. 打开 Chrome → `chrome://extensions`
2. 开启"开发者模式"
3. "加载已解压的扩展程序" → 选择 `QR Helper/` 目录

## 项目结构

```
QR Helper/
├── manifest.json                 # MV3 配置
├── _locales/en,zh_CN/            # 国际化文案
├── background/                   # Service Worker
├── content/                      # Content Script
├── popup/                        # 弹出设置面板
├── options/                      # 完整设置页
├── utils/
│   ├── zxing-loader.js           # WASM 加载器
│   └── toast.js                  # 浮动通知
├── lib/                          # zxing-wasm 库
└── wasm/                         # WASM 二进制
```

## 依赖

- [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) v3.1.1 — QR 码扫描与生成引擎
