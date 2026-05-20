# OpenCLI Smart Assistant

AI-powered intelligent code and document completion assistant. Triggered by global shortcut, analyzes your screen context, and automatically inserts smart suggestions at your cursor position.

## Features

- 🎯 **Global Shortcut** - Press `Ctrl+Space` (customizable) anywhere to trigger
- 📸 **Screen Analysis** - Captures and analyzes your current screen context
- 🤖 **AI-Powered** - Uses Doubao App for intelligent code/document completion
- ✍️ **Auto-Insert** - Automatically pastes results at your cursor position
- 🎨 **Beautiful UI** - Clean settings interface with real-time status
- 🔧 **Configurable** - Customize shortcut, timeout, behavior

## Prerequisites

1. **Doubao Desktop App** installed and launched with remote debugging:
   ```bash
   # Windows
   "D:\Program Files\Doubao\Doubao.exe" --remote-debugging-port=9225
   
   # macOS
   /Applications/Doubao.app/Contents/MacOS/Doubao --remote-debugging-port=9225
   ```

2. **Node.js** >= 18.0.0

## Installation

```bash
# Clone or navigate to the assistant directory
cd opencli-assistant

# Install dependencies
npm install

# Start the application
npm start
```

For development mode with DevTools:
```bash
npm run dev
```

## Usage

### 1. Launch Doubao App

Make sure Doubao is running with CDP enabled:
```bash
"D:\Program Files\Doubao\Doubao.exe" --remote-debugging-port=9225
```

### 2. Start OpenCLI Assistant

```bash
npm start
```

The app will run in your system tray.

### 3. Configure Settings

Open the settings window and verify:
- **CDP Endpoint**: `http://127.0.0.1:9225`
- **Shortcut**: `Control+Space` (or your preferred shortcut)
- **Auto Insert**: Enabled (recommended)

### 4. Use the Assistant

1. Switch to any application (VS Code, Word, browser, etc.)
2. Press `Ctrl+Space`
3. Wait for analysis (10-30 seconds)
4. Result is automatically inserted at your cursor!

## Configuration

### Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `shortcut` | Global keyboard shortcut | `Control+Space` |
| `doubao_cdp_endpoint` | Doubao CDP endpoint URL | `http://127.0.0.1:9225` |
| `timeout_seconds` | Analysis timeout | `30` |
| `auto_insert` | Auto-paste results | `true` |
| `show_notifications` | Show system notifications | `true` |
| `log_level` | Logging verbosity | `info` |

### Environment Variables

```bash
# Optional: Override CDP endpoint
export OPENCLI_CDP_ENDPOINT=http://127.0.0.1:9225
```

## Project Structure

```
opencli-assistant/
├── main.js                    # Electron main process
├── preload.js                 # Preload script (security bridge)
├── config.json                # Default configuration
├── core/
│   ├── screenshot.js          # Screen capture module
│   ├── doubao-client.js       # Doubao CDP client
│   ├── clipboard.js           # Clipboard & keyboard simulation
│   └── context-analyzer.js    # Active window detection
├── renderer/
│   ├── index.html             # Settings UI
│   ├── styles.css             # UI styles
│   └── renderer.js            # UI logic
└── package.json               # Project dependencies
```

## How It Works

1. **Shortcut Detection**: Listens for global keyboard shortcut
2. **Context Detection**: Identifies active application (code editor, document editor, etc.)
3. **Screen Capture**: Takes screenshot of current screen
4. **AI Analysis**: Sends context to Doubao via CDP for intelligent analysis
5. **Result Insertion**: Automatically pastes AI-generated content at cursor position

## Building for Production

### Windows
```bash
npm run build:win
```
Output: `dist/opencli-assistant-Setup.exe`

### macOS
```bash
npm run build:mac
```
Output: `dist/OpenCLI Assistant.dmg`

### Linux
```bash
npm run build:linux
```
Output: `dist/OpenCLI Assistant.AppImage`

## Troubleshooting

### "No inspectable targets found"
- Make sure Doubao is launched with `--remote-debugging-port=9225`
- Verify the port is not blocked by firewall

### Shortcut not working
- Check for shortcut conflicts with other applications
- Try a different shortcut combination
- On macOS, grant Accessibility permissions

### Robotjs installation fails
- Windows: Install Visual Studio Build Tools
- macOS: Install Xcode Command Line Tools
- Linux: Install `libx11-dev libxkbfile-dev`

### Results not inserting
- Ensure `auto_insert` is enabled in settings
- Check if the target application accepts clipboard paste
- Try manual paste (Ctrl+V)

## Security & Privacy

- ✅ Screenshots are processed locally only
- ✅ No data is stored or transmitted externally
- ✅ CDP connection is localhost only
- ✅ Clipboard content is restored after paste

## Future Enhancements

- [ ] Multi-AI support (Claude, GPT-4, etc.)
- [ ] Code template library
- [ ] History of completions
- [ ] Custom prompt templates
- [ ] Plugin system
- [ ] Voice commands

## License

Apache-2.0

## Credits

Built with ❤️ using:
- [Electron](https://www.electronjs.org/)
- [OpenCLI](https://github.com/jackwener/opencli)
- [RobotJS](https://robotjs.io/)
- [screenshot-desktop](https://github.com/bencevans/screenshot-desktop)

## Support

For issues and feature requests, please visit:
https://github.com/jackwener/opencli
