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
