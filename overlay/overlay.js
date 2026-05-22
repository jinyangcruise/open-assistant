/**
 * Overlay UI logic for the floating status bar
 */

document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('cancelBtn');
  const bar = document.querySelector('.overlay-bar');

  let isDragging = false;

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
    bar.style.cursor = 'grabbing';
    // Window position is captured in main process (sync, no async gap)
    window.electronAPI.startDrag(e.screenX, e.screenY);
  });

  // Move window during drag (delta computed in main process)
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    window.electronAPI.dragMove(e.screenX, e.screenY);
  });

  // End drag — only re-enable forwarding if cursor left the bar
  document.addEventListener('mouseup', (e) => {
    if (isDragging) {
      isDragging = false;
      bar.style.cursor = '';
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
