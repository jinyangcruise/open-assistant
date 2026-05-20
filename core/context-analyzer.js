/**
 * Context Analyzer
 * 
 * Detects active window and application context
 */

const { execSync } = require('child_process');
const os = require('os');

/**
 * Detect the currently active/focused window
 * @returns {Object} Window information
 */
function detectActiveWindow() {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      return getActiveWindowWindows();
    } else if (platform === 'darwin') {
      return getActiveWindowMac();
    } else {
      return getActiveWindowLinux();
    }
  } catch (error) {
    console.warn('Failed to detect active window:', error.message);
    return {
      title: 'Unknown',
      appName: 'Unknown',
      pid: null
    };
  }
}

/**
 * Get active window on Windows
 */
function getActiveWindowWindows() {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  
  // Create PowerShell script file to avoid escaping issues
  const script = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class User32API {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();
  
  [DllImport("user32.dll")]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
'@

$handle = [User32API]::GetForegroundWindow()
$text = New-Object System.Text.StringBuilder(256)
[User32API]::GetWindowText($handle, $text, 256) | Out-Null
$processId = 0
[User32API]::GetWindowThreadProcessId($handle, [ref]$processId) | Out-Null
$process = Get-Process -Id $processId -ErrorAction SilentlyContinue
$appName = if ($process) { $process.ProcessName } else { "Unknown" }
$title = $text.ToString()
if ([string]::IsNullOrWhiteSpace($title)) { $title = "Untitled" }

Write-Output "$title|$appName|$processId"
`;

  const tempFile = path.join(os.tmpdir(), 'get-window.ps1');
  
  try {
    fs.writeFileSync(tempFile, script);
    const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, {
      encoding: 'utf-8',
      timeout: 5000
    });

    const parts = result.trim().split('|');
    
    return {
      title: parts[0] || 'Untitled',
      appName: parts[1] || 'Unknown',
      pid: parts[2] ? parseInt(parts[2]) : null
    };
  } finally {
    try { fs.unlinkSync(tempFile); } catch (e) {}
  }
}

/**
 * Get active window on macOS
 */
function getActiveWindowMac() {
  const script = `
    tell application "System Events"
      set frontApp to name of first application process whose frontmost is true
      set windowTitle to ""
      try
        set windowTitle to name of window 1 of process frontApp
      end try
      return frontApp & "|" & windowTitle
    end tell
  `;

  const result = execSync(`osascript -e '${script}'`, {
    encoding: 'utf-8',
    timeout: 5000
  });

  const [appName, title] = result.trim().split('|');

  return {
    title: title || 'Unknown',
    appName: appName || 'Unknown',
    pid: null
  };
}

/**
 * Get active window on Linux
 */
function getActiveWindowLinux() {
  try {
    // Try xdotool first
    const result = execSync('xdotool getactivewindow getwindowname', {
      encoding: 'utf-8',
      timeout: 5000
    });

    return {
      title: result.trim() || 'Unknown',
      appName: 'Unknown',
      pid: null
    };
  } catch {
    // Fallback to wmctrl
    try {
      const result = execSync('wmctrl -l', {
        encoding: 'utf-8',
        timeout: 5000
      });

      return {
        title: result.trim() || 'Unknown',
        appName: 'Unknown',
        pid: null
      };
    } catch {
      return {
        title: 'Unknown',
        appName: 'Unknown',
        pid: null
      };
    }
  }
}

/**
 * Determine if the active app is a code editor
 * @param {string} appName
 * @returns {boolean}
 */
function isCodeEditor(appName) {
  const codeEditors = [
    'Code', 'VSCode', 'Visual Studio Code',
    'WebStorm', 'IntelliJ', 'PyCharm', 'PhpStorm',
    'Sublime Text', 'Atom',
    'Vim', 'Neovim', 'GVim',
    'Notepad++',
    'Xcode',
    'Cursor',
    'Zed'
  ];

  const lowerAppName = appName.toLowerCase();
  return codeEditors.some(editor => lowerAppName.includes(editor.toLowerCase()));
}

/**
 * Determine if the active app is a document editor
 * @param {string} appName
 * @returns {boolean}
 */
function isDocumentEditor(appName) {
  const docEditors = [
    'Word', 'Microsoft Word',
    'Google Docs',
    'Pages',
    'LibreOffice',
    'WPS',
    'Typora',
    'Obsidian',
    'Notion',
    'Bear',
    'Ulysses'
  ];

  const lowerAppName = appName.toLowerCase();
  return docEditors.some(editor => lowerAppName.includes(editor.toLowerCase()));
}

/**
 * Get context type based on active application
 * @returns {string} 'code' | 'document' | 'unknown'
 */
function detectContextType() {
  const { appName } = detectActiveWindow();

  if (isCodeEditor(appName)) {
    return 'code';
  } else if (isDocumentEditor(appName)) {
    return 'document';
  } else {
    return 'unknown';
  }
}

/**
 * Build context information object
 * @returns {Object}
 */
function buildContextInfo() {
  const windowInfo = detectActiveWindow();
  const contextType = detectContextType();

  return {
    ...windowInfo,
    contextType,
    timestamp: new Date().toISOString(),
    platform: process.platform
  };
}

module.exports = {
  detectActiveWindow,
  isCodeEditor,
  isDocumentEditor,
  detectContextType,
  buildContextInfo
};
