/**
 * Screenshot Module
 *
 * Captures screen using screenshot-desktop library
 */

const screenshot = require('screenshot-desktop');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Take a screenshot of the screen
 * @param {Object} options - Screenshot options
 * @returns {Promise<Buffer>} PNG buffer
 */
async function takeScreenshot(options = {}) {
  const defaultOptions = {
    format: 'png',
    ...options
  };

  try {
    const buffer = await screenshot(defaultOptions);
    return buffer;
  } catch (error) {
    console.error('Screenshot failed:', error.message);
    throw new Error(`Failed to capture screenshot: ${error.message}`);
  }
}

/**
 * Take screenshot of specific screen (multi-monitor setup)
 * @param {number} screenIndex - Screen index (0-based)
 * @returns {Promise<Buffer>}
 */
async function takeScreenshotOfScreen(screenIndex) {
  try {
    const buffer = await screenshot({ screen: screenIndex, format: 'png' });
    return buffer;
  } catch (error) {
    console.error('Screenshot of screen failed:', error.message);
    throw new Error(`Failed to capture screen ${screenIndex}: ${error.message}`);
  }
}

/**
 * Capture the currently focused window using PrintWindow API (Windows only)
 * Renders ONLY the target window — no overlapping windows, no desktop background
 * @returns {Promise<Buffer>} PNG buffer
 */
async function captureForegroundWindow() {
  if (os.platform() !== 'win32') {
    throw new Error('Window capture is only supported on Windows');
  }

  const script = `
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class WindowCapture {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, int nFlags);

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("dwmapi.dll")]
  public static extern int DwmGetWindowAttribute(IntPtr hwnd, int dwAttribute, out RECT pvAttribute, int cbAttribute);
}

public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
'@

$hwnd = [WindowCapture]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { Write-Error "No foreground window"; exit 1 }

# Use DWM extended frame bounds for physical-pixel-accurate window size.
# This is critical on high-DPI displays where GetWindowRect returns
# virtualized (scaled) pixels while PW_RENDERFULLCONTENT renders at
# native resolution.
$dwmRect = New-Object RECT
$dwmResult = [WindowCapture]::DwmGetWindowAttribute($hwnd, 9, [ref]$dwmRect, [System.Runtime.InteropServices.Marshal]::SizeOf($dwmRect))

if ($dwmResult -eq 0) {
  $width = $dwmRect.Right - $dwmRect.Left
  $height = $dwmRect.Bottom - $dwmRect.Top
} else {
  $winRect = New-Object RECT
  [WindowCapture]::GetWindowRect($hwnd, [ref]$winRect) | Out-Null
  $width = $winRect.Right - $winRect.Left
  $height = $winRect.Bottom - $winRect.Top
}

if ($width -le 0 -or $height -le 0) { Write-Error "Invalid window dimensions"; exit 1 }

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$hdc = $graphics.GetHdc()

# PrintWindow with PW_RENDERFULLCONTENT (0x2) — asks DWM to compose the
# full window content including title bar (fixes black title bar on Win11).
# Falls back to flag 0 if 2 produces empty content.
[WindowCapture]::PrintWindow($hwnd, $hdc, 2) | Out-Null

$graphics.ReleaseHdc($hdc)
$graphics.Dispose()

$outputPath = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), "oa-window-capture-" + [System.IO.Path]::GetRandomFileName() + ".png")
$bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output $outputPath
`;

  const tempFile = path.join(os.tmpdir(), 'capture-window.ps1');

  try {
    fs.writeFileSync(tempFile, script);
    const result = execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tempFile}"`, {
      encoding: 'utf-8',
      timeout: 15000
    });

    var outputPath = result.trim().split('\n').pop().trim();
    if (!outputPath || !fs.existsSync(outputPath)) {
      throw new Error('Window capture output file not found: ' + outputPath);
    }

    var buffer = fs.readFileSync(outputPath);
    try { fs.unlinkSync(outputPath); } catch (e) {}
    return buffer;
  } catch (error) {
    console.error('Window capture failed:', error.message);
    throw new Error(`Failed to capture foreground window: ${error.message}`);
  } finally {
    try { fs.unlinkSync(tempFile); } catch (e) {}
  }
}

/**
 * Take screenshot of a specific window by cropping from a full screenshot (fallback)
 * @param {import('electron').NativeImage} nativeImage - Electron's nativeImage module
 * @param {Object} bounds - Window bounds { x, y, width, height }
 * @returns {Promise<Buffer>} PNG buffer
 */
async function takeWindowScreenshot(nativeImage, bounds) {
  if (!bounds || bounds.width <= 0 || bounds.height <= 0) {
    throw new Error('Invalid window bounds');
  }

  const fullBuffer = await takeScreenshot();
  const image = nativeImage.createFromBuffer(fullBuffer);
  const imageSize = image.getSize();

  // Clamp bounds to screenshot dimensions
  var x = Math.max(0, bounds.x);
  var y = Math.max(0, bounds.y);
  var w = Math.min(bounds.width, imageSize.width - x);
  var h = Math.min(bounds.height, imageSize.height - y);

  if (w <= 0 || h <= 0) {
    throw new Error('Window bounds are outside the screenshot area');
  }

  var cropped = image.crop({ x: x, y: y, width: w, height: h });
  return cropped.toPNG();
}

/**
 * List available screens
 * @returns {Promise<Array>}
 */
async function listScreens() {
  try {
    const screens = await screenshot.listDisplays();
    return screens;
  } catch (error) {
    console.error('List screens failed:', error.message);
    return [];
  }
}

module.exports = {
  takeScreenshot,
  takeScreenshotOfScreen,
  takeWindowScreenshot,
  captureForegroundWindow,
  listScreens
};
