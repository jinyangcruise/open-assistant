# Quick Start Guide

## First Time Setup (5 minutes)

### Step 1: Install Dependencies

```bash
cd opencli-assistant
npm install
```

**Note**: If `robotjs` installation fails, you may need:
- **Windows**: Visual Studio Build Tools
- **macOS**: Xcode Command Line Tools (`xcode-select --install`)
- **Linux**: `sudo apt-get install libx11-dev libxkbfile-dev`

### Step 2: Launch Doubao App

**Windows:**
```bash
"D:\Program Files\Doubao\Doubao.exe" --remote-debugging-port=9225
```

Or use the startup script you created earlier:
```bash
..\start-doubao.bat
```

### Step 3: Start the Assistant

```bash
npm start
```

Or double-click `start.bat`

### Step 4: Test It!

1. Open any editor (VS Code, Word, etc.)
2. Write some code or text
3. Press `Ctrl+Space`
4. Wait 10-30 seconds
5. AI completion is automatically inserted!

## Common Issues

### "Cannot find module 'robotjs'"
```bash
npm rebuild robotjs
```

### "CDP connection failed"
- Verify Doubao is running with `--remote-debugging-port=9225`
- Check endpoint in settings matches the port

### Shortcut doesn't work
- Try `Ctrl+Shift+Space` instead
- Check for conflicts with other apps

## Need Help?

Check the full README.md or visit:
https://github.com/jackwener/opencli
