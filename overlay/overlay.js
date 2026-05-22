/**
 * Overlay UI logic for the floating status bar
 */

document.addEventListener('DOMContentLoaded', () => {
  const cancelBtn = document.getElementById('cancelBtn');
  const bar = document.querySelector('.overlay-bar');

  // Hover over the bar → disable mouse forwarding so clicks register
  bar.addEventListener('mouseenter', () => {
    window.electronAPI.setIgnoreMouseEvents(false);
  });

  bar.addEventListener('mouseleave', () => {
    window.electronAPI.setIgnoreMouseEvents(true);
  });

  // Cancel button: click sends abort
  cancelBtn.addEventListener('click', () => {
    window.electronAPI.cancelProcessing();
  });
});
