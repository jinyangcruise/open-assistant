# Changelog

## v0.5.6 — 2026-05-27

### English

#### Fixes
- **Packaged build missing region-capture files**: Added `region-capture/**/*` to `build.files` in `package.json` so the region screenshot UI works in installed builds
- **PowerShell focus script errors**: Fixed `IntPtr.Parse` not available in older .NET; `GetCurrentThreadId` moved from `user32.dll` to `kernel32.dll`

#### Changes
- Version bumped to 0.5.6

---

### 中文

#### 修复
- **打包后缺少区域截图文件**：在 `package.json` 的 `build.files` 中添加 `region-capture/**/*`，修复安装版区域截图全黑的问题
- **PowerShell 聚焦脚本报错**：修复旧版 .NET 没有 `IntPtr.Parse` 的问题；`GetCurrentThreadId` 从 `user32.dll` 移至 `kernel32.dll`

#### 变更
- 版本号更新至 0.5.6

## v0.5.5 — 2026-05-26

### English

#### New Features
- **Window screenshot mode**: Capture only the active window using PrintWindow API; falls back to crop for hardware-accelerated content
- **Region screenshot mode**: Full snipping-tool-style region selector with 8 resize handles, annotation tools (pencil, shapes, text, eraser), undo/redo, fill/stroke settings, and auto-placed toolbar
- **Annotation text tool**: Click to place text on screenshots, auto-expanding input, draggable after placement, configurable color
- **Shape drawing tools**: Rectangle, ellipse, line, arrow with fill color, stroke color, and opacity controls
- **Prompt card tooltips**: Hover over mode labels for detailed descriptions of each capture mode

#### Improvements
- **Sharp screenshots**: Full-resolution canvas rendering preserves native display pixel quality
- **Work area alignment**: Region overlay matches Windows work area (excludes taskbar) to avoid stretching
- **Tool color defaults**: All annotation tools default to red for consistency

#### Changes
- Region capture files now in `region-capture/` directory
- Version bumped to 0.5.5

---

### 中文

#### 新增功能
- **窗口截图模式**：使用 PrintWindow API 截取当前活动窗口，DirectX 内容自动回退到裁剪方式
- **矩形截图模式**：完整的截图工具风格区域选择器，含 8 个调整手柄、标注工具（铅笔、形状、文字、橡皮）、撤销/重做、填充/描边设置、自动定位工具栏
- **文字标注工具**：点击在截图上放置文字，输入框自动拓宽，确认后可拖动，支持颜色切换
- **形状绘制工具**：矩形、椭圆、直线、箭头，支持填充颜色、描边颜色和不透明度
- **提示词卡片 tooltip**：鼠标悬停模式标签时显示详细说明

#### 改进
- **高清截图**：全分辨率画布渲染，保持原始屏幕像素质量
- **工作区对齐**：区域截图覆盖层匹配 Windows 工作区（排除任务栏），避免拉伸
- **工具默认颜色**：所有标注工具默认统一为红色

#### 变更
- 区域截图的文件集中到 `region-capture/` 目录
- 版本号更新至 0.5.5


## v0.5.4 — 2026-05-25

### English

#### New Features
- **Copy button on result cards**: Each entry in Last Result now has a 📋 copy button. Click to copy AI response to clipboard.

#### Improvements
- **Home page**: Version badge next to app title ("Open Assistant 0.5.4"), and "More agents coming soon..." footer.
- **i18n coverage**: History view title and tabs now translate in Chinese mode.
- **Settings tabs**: Rounded border around tab button group for visual clarity.

---

### 中文

#### 新增功能
- **结果卡片复制按钮**：每条 AI 回复右上角的 📋 按钮，点击复制到剪贴板。

#### 改进
- **主页**：标题旁显示版本号徽标，底部显示"更多 Agent 适配中，敬请期待"。
- **多语言覆盖**：History 页面标题和页签在中文模式下正确翻译。
- **设置页签**：添加圆角边框，视觉更清晰。


## v0.5.3 — 2026-05-25

### English

#### Fixes
- **Auto-updater filename mismatch**: Added explicit `artifactName` for Windows (`OpenAssistant-Setup-${version}`), macOS, and Linux builds. Installer filenames are now consistent between `latest.yml` and the actual uploaded file.
- **Update error UX**: Network timeout or failure now shows "Network error — click to download manually" and opens GitHub Releases page on click.

#### Changes
- Updated CHANGELOG to track releases

---

### 中文

#### 修复
- **自动更新文件名不一致**：为 Windows、macOS、Linux 构建添加明确的 `artifactName`，确保 `latest.yml` 中的文件名与实际上传的文件一致
- **更新错误提示优化**：网络超时或失败时显示"网络错误 — 点击手动下载"，点击跳转 GitHub Releases

#### 变更
- 更新 CHANGELOG 以跟踪版本

## v0.5.2 — 2026-05-25

### English

#### Improvements
- **Settings tabs redesigned**: Capsule/pill style with smooth hover and active states
- **Checkbox help text**: All checkboxes now show descriptive help text aligned below
- **Startup optimization**: Auto-init Doubao checks if endpoint is already responding before launching

#### Changes
- Updated CHANGELOG to track releases

---

### 中文

#### 改进
- **设置页签改版**：胶囊/药丸风格，平滑悬停和激活状态
- **复选框帮助文字**：所有复选框显示对齐的帮助说明
- **启动优化**：自动初始化豆包前先检测 Endpoint 是否已在响应

#### 变更
- 更新 CHANGELOG 以跟踪版本

## v0.5.1 — 2026-05-25

### English

#### New Features
- **Multi-language support**: Full Chinese and English UI. Switch from the top bar
- **Per-prompt shortcuts**: Each prompt gets its own global hotkey. Enable/disable per prompt
- **UI redesign**: Home page shows agents only; Settings (⚙️) and History (🕐) are separate pages with tab navigation
- **Prompt Management**: Edit/delete buttons on each prompt item. Edit opens a modal
- **General settings tab**: Consolidated output, notification, startup, capture, and log settings
- **FAQ tab**: Troubleshooting guide
- **About tab**: Version info, check for updates (via GitHub Releases), release notes button
- **Electron auto-updater**: Built-in update checking and downloading
- **Startup options**: Launch on boot, start silently to tray, auto-initialize Doubao on startup
- **Restart agent button**: Restart Doubao from the agent card
- **Capsule UX improvements**: Tooltips show full prompt content; larger edit/clear buttons
- **View animations**: Fade-in transitions between pages and tabs

#### Fixes
- Locale files now included in packaged builds
- "Show notifications" checkbox now correctly saves when unchecked
- Config storage path changed to `%APPDATA%\OpenAssistant`
- CDP endpoint input no longer shrinks too narrow
- Window minimum size enforced (600×400)
- App menu bar removed
- Various i18n coverage improvements (tray menu, agent names, default prompt)

#### Changes
- Default prompt text cleaned up (removed excessive blank lines)
- Notification behavior: success notifications removed; only errors/timeouts remain
- Tray menu follows language setting
- Build scripts: added `--publish=never` (CI handles publishing)
- Added `electron-updater` dependency for auto-updates
- README rewritten with Chinese and English versions, screenshots added
- GitHub Actions workflow: build on push/PR, auto-release on tag

---

### 中文

#### 新增功能
- **多语言支持**：完整的英文/中文界面，顶部栏一键切换
- **按提示词设快捷键**：每个提示词独立快捷键，胶囊开关控制启用/禁用
- **界面重构**：主页仅显示 Agent 列表；设置（⚙️）和历史（🕐）为独立页面，支持页签切换
- **提示词管理**：每个提示词自带编辑/删除按钮，编辑使用弹窗
- **通用设置页签**：整合输出方式、通知、启动项、捕获模式、日志等设置
- **常见问题页签**：使用中的常见问题及解答
- **关于页签**：版本信息、检查更新（通过 GitHub Releases）、更新日志按钮
- **自动更新**：集成 electron-updater，支持检测新版本并自动下载安装
- **启动选项**：开机自启、静默启动到托盘、启动时自动初始化豆包
- **重启 Agent 按钮**：Agent 卡片上一键重启豆包
- **胶囊交互优化**：悬停显示完整提示词；编辑/清除按钮增大
- **页面动画**：页面和页签切换时的淡入过渡效果

#### 修复
- 翻译文件现已包含在打包构建中
- "显示通知"复选框取消勾选后能正确保存
- 配置文件路径改为 `%APPDATA%\OpenAssistant`
- CDP Endpoint 输入框在窗口缩窄时不再过窄
- 窗口最小尺寸限制（600×400）
- 移除了顶部菜单栏
- 多语言覆盖改进（托盘菜单、Agent 名称、默认提示词）

#### 变更
- 默认提示词格式清理（去除多余空行）
- 通知行为调整：移除成功通知，仅保留错误和超时提示
- 托盘菜单跟随语言切换
- 构建脚本添加 `--publish=never`（由 CI 负责发布）
- 新增 `electron-updater` 依赖
- README 重写为中英双语，添加截图
- GitHub Actions 工作流：提交/PR 自动构建，打 tag 自动发布 Release
