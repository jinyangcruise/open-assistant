/**
 * Overlay UI logic for the floating status bar
 */

document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('cancelBtn');
  const bar = document.querySelector('.overlay-bar');
  const debugEl = document.getElementById('debugInfo');

  let isDragging = false;
  let zeroMovementCount = 0; // consecutive mousemove with movementX/Y=0 during drag

  // ── Real-time position/size debug display ──
  let mainPosCache = { x: 0, y: 0 };

  // Query main process window position
  function updateMainPos() {
    if (window.electronAPI && window.electronAPI.getWindowPosition) {
      window.electronAPI.getWindowPosition().then(pos => {
        mainPosCache = pos;
      }).catch(() => {});
    }
  }

  function updateDebugInfo() {
    updateMainPos();
    const r = { sx: window.screenX, sy: window.screenY, iw: window.innerWidth, ih: window.innerHeight };
    debugEl.textContent = `R:(${r.sx},${r.sy}) ${r.iw}×${r.ih}  |  M:(${mainPosCache.x},${mainPosCache.y})`;
  }

  // Poll position 10 times/second
  setInterval(updateDebugInfo, 100);
  updateDebugInfo(); // initial

  // Periodically send debug position to main process for console logging
  function sendDebugToMain() {
    window.electronAPI.sendDebugPos(
      window.screenX, window.screenY,
      window.innerWidth, window.innerHeight
    );
  }
  setInterval(sendDebugToMain, 2000);
  sendDebugToMain(); // immediate first send

  // ── Drag logic ──

  // Hover over the bar → disable mouse forwarding so clicks register
  bar.addEventListener('mouseenter', () => {
    window.electronAPI.setIgnoreMouseEvents(false);
  });

  bar.addEventListener('mouseleave', () => {
    // Keep forwarding disabled during drag so mousemove/mouseup keep working
    if (!isDragging) {
      window.electronAPI.setIgnoreMouseEvents(true);
    }
  });

  // Start dragging (except on cancel button)
  bar.addEventListener('mousedown', (e) => {
    if (e.target.closest('#cancelBtn')) return;
    isDragging = true;
    zeroMovementCount = 0;
    bar.style.cursor = 'grabbing';
    window.electronAPI.debugLog('mousedown screen=(%d,%d) client=(%d,%d)', e.screenX, e.screenY, e.clientX, e.clientY);
    // Send window position from renderer's DOM (same coordinate system as screenX/clientX)
    // to avoid DWM getPosition() inconsistency on transparent frameless windows.
    window.electronAPI.startDrag(e.screenX, e.screenY, window.screenX, window.screenY);
  });

  // Move window during drag (delta computed in main process)
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    // Detect mouseup that fired outside the overlay window (e.g. on Doubao).
    // When e.buttons no longer has the left button set, the user released elsewhere.
    if (!(e.buttons & 1)) {
      isDragging = false;
      zeroMovementCount = 0;
      bar.style.cursor = '';
      window.electronAPI.endDrag();
      window.electronAPI.setIgnoreMouseEvents(true);
      return;
    }
    // Synthetic event storm defense: if >10 consecutive zero-movement events,
    // force end drag. This prevents isDragging getting stuck during SSE.
    if (e.movementX === 0 && e.movementY === 0) {
      zeroMovementCount++;
      if (zeroMovementCount > 10) {
        isDragging = false;
        zeroMovementCount = 0;
        bar.style.cursor = '';
        window.electronAPI.endDrag();
        window.electronAPI.setIgnoreMouseEvents(true);
        window.electronAPI.debugLog('mousemove SYNTHETIC_STORM force endDrag');
        return;
      }
    } else {
      zeroMovementCount = 0;
    }
    window.electronAPI.debugLog('mousemove screen=(%d,%d) movement=(%d,%d)', e.screenX, e.screenY, e.movementX, e.movementY);
    // Send movement delta instead of absolute screenX — synthetic mousemove
    // events (movementX=0) during SSE carry the real cursor position which
    // differs from the drag origin and would cause window snap-back.
    window.electronAPI.dragMove(e.movementX, e.movementY);
  });

  // End drag — only re-enable forwarding if cursor left the bar
  document.addEventListener('mouseup', (e) => {
    if (isDragging) {
      isDragging = false;
      zeroMovementCount = 0;
      bar.style.cursor = '';
      window.electronAPI.debugLog('mouseup  screen=(%d,%d)', e.screenX, e.screenY);
      window.electronAPI.endDrag();
      // If the mouse is NOT over the bar after releasing, re-enable forwarding.
      // If the mouse IS over the bar, keep forwarding off so the user can click "取消".
      const rect = bar.getBoundingClientRect();
      if (e.clientX < rect.left || e.clientX > rect.right ||
          e.clientY < rect.top || e.clientY > rect.bottom) {
        window.electronAPI.setIgnoreMouseEvents(true);
      }
    }
  });

  // Cancel button: click sends abort
  cancelBtn.addEventListener('click', () => {
    window.electronAPI.cancelProcessing();
  });
});
