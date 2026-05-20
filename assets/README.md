# OpenCLI Smart Assistant - 图标说明

## 需要的图标文件

为了完整的应用体验，建议添加以下图标文件：

### 1. 应用图标
- **位置**: `assets/icon.png` (512x512)
- **用途**: 应用窗口图标、安装包图标
- **格式**: PNG（开发）, ICO（Windows）, ICNS（macOS）

### 2. 托盘图标
- **位置**: `assets/tray-icon.png` (32x32 或 64x64)
- **用途**: 系统托盘显示
- **格式**: PNG（带透明背景）

### 3. 临时方案

如果暂时没有图标，应用仍可正常运行：
- Electron 会使用默认图标
- 托盘图标会显示为空白方块

### 4. 推荐图标设计

```
┌─────────────────────────────┐
│                             │
│      🤖 机器人头像          │
│                             │
│   OpenCLI Assistant         │
│                             │
│   蓝紫色渐变背景            │
│   (#4f46e5 → #764ba2)      │
│                             │
└─────────────────────────────┘
```

### 5. 在线图标生成器

- **App Icon**: https://appicon.co/
- **Favicon**: https://favicon.io/
- **自定义**: 使用 Figma、Sketch 或 Photoshop

### 6. 免费图标资源

- https://icons8.com/
- https://www.flaticon.com/
- https://feathericons.com/

## 创建 assets 目录

```bash
mkdir assets
```

然后放入图标文件即可。
