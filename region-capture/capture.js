/**
 * Region Capture - Selection and Annotation Logic
 *
 * Full-screen region selector with resize handles, annotation tools,
 * and toolbar placement. Communicates with main process via regionCaptureAPI.
 */

// ─── Constants ─────────────────────────────────────────────────────────────

var HANDLE_SIZE = 10;
var HANDLE_HIT = 12; // hit test radius
var MIN_SEL_SIZE = 10;
var TOOLBAR_GAP = 8;
var TOOLBAR_HEIGHT = 44; // approximate, updated dynamically

var HANDLES = [
  { id: 'nw', cursor: 'nwse-resize' },
  { id: 'n',  cursor: 'ns-resize' },
  { id: 'ne', cursor: 'nesw-resize' },
  { id: 'w',  cursor: 'ew-resize' },
  { id: 'e',  cursor: 'ew-resize' },
  { id: 'sw', cursor: 'nesw-resize' },
  { id: 's',  cursor: 'ns-resize' },
  { id: 'se', cursor: 'nwse-resize' },
];

// ─── State ─────────────────────────────────────────────────────────────────

var state = {
  screenshotImage: null,
  screenW: 0,
  screenH: 0,

  // Selection (CSS pixels)
  sel: null, // { x, y, w, h } or null

  // Initial selection drag
  isSelecting: false,
  selectStart: null,

  // Handle drag
  activeHandle: null,
  dragStartSel: null, // snapshot of sel before handle drag
  dragStartMouse: null,

  // Move selection
  isMoving: false,
  moveStartMouse: null,
  moveStartSel: null,

  // Tool: 'move' | 'pencil' | 'shape' | 'eraser'
  currentTool: 'shape',

  // Annotations
  annotations: [], // array of stroke objects
  redoStack: [], // undone annotations for redo
  currentStroke: null, // stroke being drawn
  shapeStart: null, // mouse-down point for shape tool
};

// ─── DOM refs ──────────────────────────────────────────────────────────────

var canvas, ctx, toolbar;

// ─── Handle rect helper ────────────────────────────────────────────────────

function getHandleRect(id, sel) {
  var s = HANDLE_SIZE;
  var h = s / 2;
  var cx = sel.x + sel.w / 2;
  var cy = sel.y + sel.h / 2;
  switch (id) {
    case 'nw': return { x: sel.x - h, y: sel.y - h, w: s, h: s };
    case 'n':  return { x: cx - h, y: sel.y - h, w: s, h: s };
    case 'ne': return { x: sel.x + sel.w - h, y: sel.y - h, w: s, h: s };
    case 'w':  return { x: sel.x - h, y: cy - h, w: s, h: s };
    case 'e':  return { x: sel.x + sel.w - h, y: cy - h, w: s, h: s };
    case 'sw': return { x: sel.x - h, y: sel.y + sel.h - h, w: s, h: s };
    case 's':  return { x: cx - h, y: sel.y + sel.h - h, w: s, h: s };
    case 'se': return { x: sel.x + sel.w - h, y: sel.y + sel.h - h, w: s, h: s };
  }
  return { x: 0, y: 0, w: s, h: s };
}

function hitTestHandle(mx, my, sel) {
  for (var i = 0; i < HANDLES.length; i++) {
    var hr = getHandleRect(HANDLES[i].id, sel);
    var cx = hr.x + hr.w / 2;
    var cy = hr.y + hr.h / 2;
    if (Math.abs(mx - cx) < HANDLE_HIT && Math.abs(my - cy) < HANDLE_HIT) {
      return HANDLES[i].id;
    }
  }
  return null;
}

function getHandleCursor(handleId) {
  for (var i = 0; i < HANDLES.length; i++) {
    if (HANDLES[i].id === handleId) return HANDLES[i].cursor;
  }
  return 'crosshair';
}

// ─── Rendering ─────────────────────────────────────────────────────────────

function render() {
  var img = state.screenshotImage;
  var w = state.screenW;
  var h = state.screenH;
  var sel = state.sel;

  ctx.clearRect(0, 0, w, h);

  // 1. Screenshot background
  if (img) {
    ctx.drawImage(img, 0, 0, w, h);
  }

  // 2. Dark overlay using 4-rectangle cutout
  ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
  if (sel && sel.w > 0 && sel.h > 0) {
    // top
    ctx.fillRect(0, 0, w, sel.y);
    // bottom
    ctx.fillRect(0, sel.y + sel.h, w, h - sel.y - sel.h);
    // left (middle strip)
    ctx.fillRect(0, sel.y, sel.x, sel.h);
    // right (middle strip)
    ctx.fillRect(sel.x + sel.w, sel.y, w - sel.x - sel.w, sel.h);
  } else {
    ctx.fillRect(0, 0, w, h);
  }

  if (!sel || sel.w <= 0 || sel.h <= 0) return;

  // 3. Annotations (clipped to selection)
  ctx.save();
  ctx.beginPath();
  ctx.rect(sel.x, sel.y, sel.w, sel.h);
  ctx.clip();
  renderAnnotations(ctx);
  ctx.restore();

  // 4. Selection border
  ctx.strokeStyle = '#FFD700';
  ctx.lineWidth = 2;
  ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);

  // 5. Resize handles
  for (var i = 0; i < HANDLES.length; i++) {
    var hr = getHandleRect(HANDLES[i].id, sel);
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(hr.x, hr.y, hr.w, hr.h);
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 1;
    ctx.strokeRect(hr.x, hr.y, hr.w, hr.h);
  }

  // 6. Dimension label
  ctx.fillStyle = 'rgba(255, 215, 0, 0.9)';
  ctx.font = '13px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  var dimText = sel.w + ' × ' + sel.h;
  var labelX = sel.x + sel.w / 2;
  var labelY = sel.y - 8;
  if (labelY < 16) labelY = sel.y + sel.h + 18;
  ctx.fillText(dimText, labelX, labelY);
}

function renderAnnotations(context) {
  var anns = state.annotations;
  for (var i = 0; i < anns.length; i++) {
    var s = anns[i];
    context.beginPath();
    context.strokeStyle = s.color;
    context.lineWidth = s.width;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    if (s.type === 'pencil' && s.points.length >= 1) {
      context.moveTo(s.points[0].x, s.points[0].y);
      for (var j = 1; j < s.points.length; j++) {
        context.lineTo(s.points[j].x, s.points[j].y);
      }
      context.stroke();
    } else if (s.type === 'rect') {
      var rx = Math.min(s.start.x, s.end.x);
      var ry = Math.min(s.start.y, s.end.y);
      var rw = Math.abs(s.end.x - s.start.x);
      var rh = Math.abs(s.end.y - s.start.y);
      context.strokeRect(rx, ry, rw, rh);
    }
  }
}

// ─── Toolbar positioning ───────────────────────────────────────────────────

function updateToolbar() {
  var sel = state.sel;
  if (!sel || sel.w <= 0 || sel.h <= 0) {
    toolbar.style.display = 'none';
    return;
  }

  toolbar.style.display = 'flex';

  // Read actual toolbar dimensions after making it visible briefly
  var tbW = toolbar.offsetWidth || 280;
  var tbH = toolbar.offsetHeight || TOOLBAR_HEIGHT;

  var sw = state.screenW;
  var sh = state.screenH;

  // Center X of toolbar aligns with center X of selection
  var cx = sel.x + sel.w / 2;
  var tx = Math.max(4, Math.min(sw - tbW - 4, cx - tbW / 2));

  // Try placing below, then above, then inside near bottom
  var ty;
  var spaceBelow = sh - (sel.y + sel.h);
  if (spaceBelow >= tbH + TOOLBAR_GAP) {
    ty = sel.y + sel.h + TOOLBAR_GAP;
  } else if (sel.y >= tbH + TOOLBAR_GAP) {
    ty = sel.y - tbH - TOOLBAR_GAP;
  } else {
    // Inside selection, near bottom
    ty = sel.y + sel.h - tbH - TOOLBAR_GAP;
  }

  toolbar.style.left = tx + 'px';
  toolbar.style.top = ty + 'px';
}

// ─── Selection normalization ───────────────────────────────────────────────

function normalizeRect(x1, y1, x2, y2) {
  var x = Math.min(x1, x2);
  var y = Math.min(y1, y2);
  var w = Math.abs(x2 - x1);
  var h = Math.abs(y2 - y1);
  return { x: x, y: y, w: w, h: h };
}

function clampSel(sel) {
  if (!sel) return null;
  var clamped = {
    x: Math.max(0, sel.x),
    y: Math.max(0, sel.y),
    w: Math.min(sel.w, state.screenW - sel.x),
    h: Math.min(sel.h, state.screenH - sel.y),
  };
  if (clamped.w < MIN_SEL_SIZE || clamped.h < MIN_SEL_SIZE) return null;
  return clamped;
}

// ─── Handle resize logic ───────────────────────────────────────────────────

function computeResizedSel(handleId, startSel, dx, dy) {
  var s = { x: startSel.x, y: startSel.y, w: startSel.w, h: startSel.h };

  switch (handleId) {
    case 'nw': s.x += dx; s.y += dy; s.w -= dx; s.h -= dy; break;
    case 'n':  s.y += dy; s.h -= dy; break;
    case 'ne': s.y += dy; s.w += dx; s.h -= dy; break;
    case 'w':  s.x += dx; s.w -= dx; break;
    case 'e':  s.w += dx; break;
    case 'sw': s.x += dx; s.w -= dx; s.h += dy; break;
    case 's':  s.h += dy; break;
    case 'se': s.w += dx; s.h += dy; break;
  }

  // Clamp to screen
  if (s.x < 0) { s.w += s.x; s.x = 0; }
  if (s.y < 0) { s.h += s.y; s.y = 0; }
  if (s.x + s.w > state.screenW) s.w = state.screenW - s.x;
  if (s.y + s.h > state.screenH) s.h = state.screenH - s.y;

  // Enforce minimum
  if (s.w < MIN_SEL_SIZE) {
    if (handleId === 'w' || handleId === 'nw' || handleId === 'sw') {
      s.x -= (MIN_SEL_SIZE - s.w);
    }
    s.w = MIN_SEL_SIZE;
  }
  if (s.h < MIN_SEL_SIZE) {
    if (handleId === 'n' || handleId === 'nw' || handleId === 'ne') {
      s.y -= (MIN_SEL_SIZE - s.h);
    }
    s.h = MIN_SEL_SIZE;
  }

  // Re-clamp after min-size adjustment
  if (s.x < 0) s.x = 0;
  if (s.y < 0) s.y = 0;
  if (s.x + s.w > state.screenW) s.w = state.screenW - s.x;
  if (s.y + s.h > state.screenH) s.h = state.screenH - s.y;

  return s;
}

// ─── Eraser hit test ───────────────────────────────────────────────────────

function eraseAtPoint(mx, my) {
  var RADIUS = 12;
  var keep = [];
  for (var i = 0; i < state.annotations.length; i++) {
    var s = state.annotations[i];
    var hit = false;
    if (s.type === 'pencil') {
      for (var j = 0; j < s.points.length; j++) {
        if (Math.abs(s.points[j].x - mx) < RADIUS && Math.abs(s.points[j].y - my) < RADIUS) {
          hit = true;
          break;
        }
      }
    } else if (s.type === 'rect') {
      var minX = Math.min(s.start.x, s.end.x) - RADIUS;
      var maxX = Math.max(s.start.x, s.end.x) + RADIUS;
      var minY = Math.min(s.start.y, s.end.y) - RADIUS;
      var maxY = Math.max(s.start.y, s.end.y) + RADIUS;
      if (mx >= minX && mx <= maxX && my >= minY && my <= maxY) {
        hit = true;
      }
    }
    if (!hit) keep.push(s);
  }
  state.annotations = keep;
}

// ─── Final composite (on Confirm) ──────────────────────────────────────────

function buildFinalImage() {
  var sel = state.sel;
  if (!sel || sel.w <= 0 || sel.h <= 0) return null;

  var finalCanvas = document.createElement('canvas');
  finalCanvas.width = Math.round(sel.w);
  finalCanvas.height = Math.round(sel.h);
  var fctx = finalCanvas.getContext('2d');

  // 1. Draw cropped screenshot region
  fctx.drawImage(
    state.screenshotImage,
    sel.x, sel.y, sel.w, sel.h, // source
    0, 0, sel.w, sel.h          // dest
  );

  // 2. Draw annotations (translated to local coordinates)
  for (var i = 0; i < state.annotations.length; i++) {
    var s = state.annotations[i];
    fctx.beginPath();
    fctx.strokeStyle = s.color;
    fctx.lineWidth = s.width;
    fctx.lineCap = 'round';
    fctx.lineJoin = 'round';

    if (s.type === 'pencil' && s.points.length >= 1) {
      fctx.moveTo(s.points[0].x - sel.x, s.points[0].y - sel.y);
      for (var j = 1; j < s.points.length; j++) {
        fctx.lineTo(s.points[j].x - sel.x, s.points[j].y - sel.y);
      }
      fctx.stroke();
    } else if (s.type === 'rect') {
      var rx = Math.min(s.start.x, s.end.x) - sel.x;
      var ry = Math.min(s.start.y, s.end.y) - sel.y;
      var rw = Math.abs(s.end.x - s.start.x);
      var rh = Math.abs(s.end.y - s.start.y);
      fctx.strokeRect(rx, ry, rw, rh);
    }
  }

  // 3. Clear toolbar overlap (if toolbar is over the selection)
  var tb = toolbar;
  var tbRect = tb.getBoundingClientRect();
  // Check if toolbar overlaps with selection
  var tbx = tbRect.left;
  var tby = tbRect.top;
  var tbw = tbRect.width;
  var tbh = tbRect.height;

  // Calculate overlap in selection-local coordinates
  var ox = Math.max(tbx, sel.x);
  var oy = Math.max(tby, sel.y);
  var ox2 = Math.min(tbx + tbw, sel.x + sel.w);
  var oy2 = Math.min(tby + tbh, sel.y + sel.h);
  var ow = ox2 - ox;
  var oh = oy2 - oy;

  if (ow > 0 && oh > 0) {
    // Re-draw that portion from screenshot only (no annotations on top of toolbar)
    fctx.drawImage(
      state.screenshotImage,
      ox, oy, ow, oh,     // source from full screenshot
      ox - sel.x, oy - sel.y, ow, oh  // dest in final canvas
    );
  }

  return finalCanvas.toDataURL('image/png');
}

// ─── Mouse events ──────────────────────────────────────────────────────────

function getMousePos(e) {
  var rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onMouseDown(e) {
  if (e.button !== 0) return; // left button only
  var pos = getMousePos(e);
  var mx = pos.x, my = pos.y;

  // 1. Always check handle hit first (any tool can resize)
  if (state.sel) {
    var hit = hitTestHandle(mx, my, state.sel);
    if (hit) {
      state.activeHandle = hit;
      state.dragStartSel = { x: state.sel.x, y: state.sel.y, w: state.sel.w, h: state.sel.h };
      state.dragStartMouse = { x: mx, y: my };
      return;
    }
  }

  // 2. No selection yet → always create one (regardless of tool)
  if (!state.sel) {
    state.isSelecting = true;
    state.selectStart = { x: mx, y: my };
    return;
  }

  // 3. Selection exists → handle based on current tool
  if (state.currentTool === 'move') {
    if (mx >= state.sel.x && mx <= state.sel.x + state.sel.w &&
        my >= state.sel.y && my <= state.sel.y + state.sel.h) {
      state.isMoving = true;
      state.moveStartMouse = { x: mx, y: my };
      state.moveStartSel = { x: state.sel.x, y: state.sel.y, w: state.sel.w, h: state.sel.h };
    }
    return;
  }

  if (state.currentTool === 'pencil' && state.sel) {
    state.redoStack = [];
    state.currentStroke = { type: 'pencil', color: '#FFD700', width: 3, points: [{ x: mx, y: my }] };
    state.annotations.push(state.currentStroke);
    render();
    return;
  }

  if (state.currentTool === 'shape' && state.sel) {
    state.redoStack = [];
    state.shapeStart = { x: mx, y: my };
    state.currentStroke = { type: 'rect', color: '#FF6B6B', width: 2, start: { x: mx, y: my }, end: { x: mx, y: my } };
    state.annotations.push(state.currentStroke);
    render();
    return;
  }

  if (state.currentTool === 'eraser' && state.sel) {
    eraseAtPoint(mx, my);
    render();
    return;
  }
}

function onMouseMove(e) {
  var pos = getMousePos(e);
  var mx = pos.x, my = pos.y;

  // Initial selection drag
  if (state.isSelecting && state.selectStart) {
    var rect = normalizeRect(state.selectStart.x, state.selectStart.y, mx, my);
    state.sel = clampSel(rect);
    updateToolbar();
    render();
    return;
  }

  // Handle drag
  if (state.activeHandle && state.dragStartSel && state.dragStartMouse) {
    var dx = mx - state.dragStartMouse.x;
    var dy = my - state.dragStartMouse.y;
    state.sel = computeResizedSel(state.activeHandle, state.dragStartSel, dx, dy);
    updateToolbar();
    render();
    return;
  }

  // Move selection
  if (state.isMoving && state.moveStartSel && state.moveStartMouse) {
    var dx = mx - state.moveStartMouse.x;
    var dy = my - state.moveStartMouse.y;
    var ns = {
      x: state.moveStartSel.x + dx,
      y: state.moveStartSel.y + dy,
      w: state.moveStartSel.w,
      h: state.moveStartSel.h,
    };
    state.sel = clampSel(ns);
    updateToolbar();
    render();
    return;
  }

  // Pencil drawing
  if (state.currentStroke && state.currentStroke.type === 'pencil') {
    state.currentStroke.points.push({ x: mx, y: my });
    render();
    return;
  }

  // Shape drawing (update end point)
  if (state.currentStroke && state.currentStroke.type === 'rect' && state.shapeStart) {
    state.currentStroke.end = { x: mx, y: my };
    render();
    return;
  }

  // Eraser drag
  if (state.currentTool === 'eraser' && e.buttons === 1 && state.sel) {
    eraseAtPoint(mx, my);
    render();
    return;
  }

  // Update cursor (handle cursors work regardless of tool)
  if (state.sel) {
    var hit = hitTestHandle(mx, my, state.sel);
    if (hit) {
      canvas.style.cursor = getHandleCursor(hit);
    } else if (mx >= state.sel.x && mx <= state.sel.x + state.sel.w &&
               my >= state.sel.y && my <= state.sel.y + state.sel.h) {
      canvas.style.cursor = state.currentTool === 'move' ? 'move' : 'crosshair';
    } else {
      canvas.style.cursor = 'crosshair';
    }
  } else {
    canvas.style.cursor = 'crosshair';
  }
}

function onMouseUp(e) {
  if (e.button !== 0) return;

  if (state.isSelecting) {
    state.isSelecting = false;
    state.selectStart = null;
    if (state.sel) updateToolbar();
    render();
    return;
  }

  if (state.activeHandle) {
    state.activeHandle = null;
    state.dragStartSel = null;
    state.dragStartMouse = null;
    if (state.sel) updateToolbar();
    render();
    return;
  }

  if (state.isMoving) {
    state.isMoving = false;
    state.moveStartMouse = null;
    state.moveStartSel = null;
    if (state.sel) updateToolbar();
    render();
    return;
  }

  if (state.currentStroke) {
    state.currentStroke = null;
    state.shapeStart = null;
    render();
    return;
  }
}

// ─── Tool selection ────────────────────────────────────────────────────────

function selectTool(tool) {
  state.currentTool = tool;
  toolbar.querySelectorAll('.toolbar-btn[data-tool]').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-tool') === tool);
  });
}

// ─── Undo ──────────────────────────────────────────────────────────────────

function undoLastAnnotation() {
  if (state.annotations.length === 0) return;
  for (var i = state.annotations.length - 1; i >= 0; i--) {
    var a = state.annotations[i];
    if (a.type === 'pencil' || a.type === 'rect') {
      state.annotations.splice(i, 1);
      state.redoStack.push(a);
      break;
    }
  }
  render();
}

// ─── Redo ───────────────────────────────────────────────────────────────────

function redoAnnotation() {
  if (state.redoStack.length === 0) return;
  var a = state.redoStack.pop();
  state.annotations.push(a);
  render();
}

// ─── Cancel ────────────────────────────────────────────────────────────────

function onCancel() {
  window.regionCaptureAPI.cancelRegion();
}

// ─── Init ──────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function() {
  canvas = document.getElementById('displayCanvas');
  ctx = canvas.getContext('2d');
  toolbar = document.getElementById('toolbar');

  // Listen for capture start from main process
  window.regionCaptureAPI.onCaptureStart(function(data) {
    state.screenW = data.screenBounds.width;
    state.screenH = data.screenBounds.height;

    canvas.width = data.screenBounds.width;
    canvas.height = data.screenBounds.height;

    var img = new Image();
    img.onload = function() {
      state.screenshotImage = img;
      render();
    };
    img.src = data.dataUrl;
  });

  // Canvas mouse events
  canvas.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);

  // Toolbar buttons
  toolbar.querySelectorAll('.toolbar-btn[data-tool]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var tool = this.getAttribute('data-tool');
      if (tool === 'undo') {
        undoLastAnnotation();
      } else if (tool === 'redo') {
        redoAnnotation();
      } else {
        selectTool(tool);
      }
    });
  });

  document.getElementById('confirmBtn').addEventListener('click', function() {
    var dataUrl = buildFinalImage();
    if (dataUrl) {
      window.regionCaptureAPI.confirmRegion(dataUrl);
    }
  });

  document.getElementById('cancelBtn').addEventListener('click', onCancel);

  // Escape key
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') onCancel();
  });
});
