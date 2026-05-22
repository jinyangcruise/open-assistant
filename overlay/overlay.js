/**
 * Overlay UI logic for the floating status bar
 */

document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('cancelBtn');

  // Notify main process when user hovers over/leaves the cancel button
  // so it can enable/disable mouse event forwarding.
  cancelBtn.addEventListener('mouseenter', () => {
    window.electronAPI.setIgnoreMouseEvents(false);
  });

  cancelBtn.addEventListener('mouseleave', () => {
    window.electronAPI.setIgnoreMouseEvents(true);
  });

  // Cancel button click → tell main process to abort
  cancelBtn.addEventListener('click', () => {
    window.electronAPI.cancelProcessing();
  });
});
