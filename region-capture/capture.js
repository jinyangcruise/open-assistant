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

  // Pencil settings
  pencilColor: '#FFD700',
  pencilWidth: 3,

  // Shape settings
  shapeType: 'rect', // 'rect' | 'ellipse' | 'line' | 'arrow'
  shapeFillColor: null, // null = no fill
  shapeFillOpacity: 0.5,
  shapeStrokeColor: '#FF6B6B',
  shapeStrokeOpacity: 1,

  // Annotations
  annotations: [], // array of stroke objects
  redoStack: [], // undone annotations for redo
  currentStroke: null, // stroke being drawn
  shapeStart: null, // mouse-down point for shape tool
};

// ─── DOM refs ──────────────────────────────────────────────────────────────

var canvas, ctx, toolbar, pencilSettings, shapeToolbar, fillPopup, strokePopup;

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
    context.save();

    if (s.type === 'pencil') {
      if (!s.points || s.points.length < 1) { context.restore(); continue; }
      context.beginPath();
      context.strokeStyle = s.color;
      context.lineWidth = s.width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.moveTo(s.points[0].x, s.points[0].y);
      for (var j = 1; j < s.points.length; j++) {
        context.lineTo(s.points[j].x, s.points[j].y);
      }
      context.stroke();
      context.restore();
      continue;
    }

    // Shape types: rect, ellipse, line, arrow
    var sx = Math.min(s.start.x, s.end.x);
    var sy = Math.min(s.start.y, s.end.y);
    var sw = Math.abs(s.end.x - s.start.x);
    var sh = Math.abs(s.end.y - s.start.y);
    var cx = (s.start.x + s.end.x) / 2;
    var cy = (s.start.y + s.end.y) / 2;

    // Fill (for rect and ellipse)
    if (s.fillColor && (s.type === 'rect' || s.type === 'ellipse')) {
      var fillAlpha = s.fillOpacity !== undefined ? s.fillOpacity : 1;
      context.fillStyle = s.fillColor;
      context.globalAlpha = fillAlpha;
      context.beginPath();
      if (s.type === 'rect') {
        context.rect(sx, sy, sw, sh);
      } else if (s.type === 'ellipse') {
        context.ellipse(cx, cy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      }
      context.fill();
      context.globalAlpha = 1;
    }

    // Stroke
    var strokeAlpha = s.strokeOpacity !== undefined ? s.strokeOpacity : 1;
    context.beginPath();
    context.strokeStyle = s.color;
    context.lineWidth = s.width || 2;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.globalAlpha = strokeAlpha;

    if (s.type === 'rect') {
      context.rect(sx, sy, sw, sh);
      context.stroke();
    } else if (s.type === 'ellipse') {
      context.ellipse(cx, cy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      context.stroke();
    } else if (s.type === 'line' || s.type === 'arrow') {
      context.moveTo(s.start.x, s.start.y);
      context.lineTo(s.end.x, s.end.y);
      context.stroke();
      // Arrowhead
      if (s.type === 'arrow') {
        var angle = Math.atan2(s.end.y - s.start.y, s.end.x - s.start.x);
        var headLen = 12;
        var headAngle = 0.5; // radians
        context.beginPath();
        context.moveTo(s.end.x, s.end.y);
        context.lineTo(
          s.end.x - headLen * Math.cos(angle - headAngle),
          s.end.y - headLen * Math.sin(angle - headAngle)
        );
        context.moveTo(s.end.x, s.end.y);
        context.lineTo(
          s.end.x - headLen * Math.cos(angle + headAngle),
          s.end.y - headLen * Math.sin(angle + headAngle)
        );
        context.stroke();
      }
    }

    context.globalAlpha = 1;
    context.restore();
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

  // Also reposition shape toolbar if it's visible
  if (shapeToolbar && state.currentTool === 'shape') {
    positionShapeToolbar();
  }
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

  var dpr = window.devicePixelRatio || 1;
  var finalCanvas = document.createElement('canvas');
  finalCanvas.width = Math.round(sel.w * dpr);
  finalCanvas.height = Math.round(sel.h * dpr);
  var fctx = finalCanvas.getContext('2d');
  fctx.scale(dpr, dpr);

  // 1. Draw cropped screenshot region at physical resolution
  fctx.drawImage(
    state.screenshotImage,
    sel.x * dpr, sel.y * dpr, sel.w * dpr, sel.h * dpr, // source (physical pixels)
    0, 0, sel.w, sel.h                                    // dest (CSS px, scaled by dpr)
  );

  // 2. Draw annotations (translated to local coordinates)
  for (var i = 0; i < state.annotations.length; i++) {
    var s = state.annotations[i];
    fctx.save();

    if (s.type === 'pencil') {
      if (!s.points || s.points.length < 1) { fctx.restore(); continue; }
      fctx.beginPath();
      fctx.strokeStyle = s.color;
      fctx.lineWidth = s.width;
      fctx.lineCap = 'round';
      fctx.lineJoin = 'round';
      fctx.moveTo(s.points[0].x - sel.x, s.points[0].y - sel.y);
      for (var j = 1; j < s.points.length; j++) {
        fctx.lineTo(s.points[j].x - sel.x, s.points[j].y - sel.y);
      }
      fctx.stroke();
      fctx.restore();
      continue;
    }

    // Shape types
    var sx = Math.min(s.start.x, s.end.x) - sel.x;
    var sy = Math.min(s.start.y, s.end.y) - sel.y;
    var sw = Math.abs(s.end.x - s.start.x);
    var sh = Math.abs(s.end.y - s.start.y);
    var cx = (s.start.x + s.end.x) / 2 - sel.x;
    var cy = (s.start.y + s.end.y) / 2 - sel.y;

    var strokeAlpha = s.strokeOpacity !== undefined ? s.strokeOpacity : 1;

    // Fill
    if (s.fillColor && (s.type === 'rect' || s.type === 'ellipse')) {
      var fillAlpha = s.fillOpacity !== undefined ? s.fillOpacity : 1;
      fctx.fillStyle = s.fillColor;
      fctx.globalAlpha = fillAlpha;
      fctx.beginPath();
      if (s.type === 'rect') fctx.rect(sx, sy, sw, sh);
      else if (s.type === 'ellipse') fctx.ellipse(cx, cy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      fctx.fill();
      fctx.globalAlpha = 1;
    }

    // Stroke
    fctx.beginPath();
    fctx.strokeStyle = s.color;
    fctx.lineWidth = s.width || 2;
    fctx.lineCap = 'round';
    fctx.lineJoin = 'round';
    fctx.globalAlpha = strokeAlpha;

    if (s.type === 'rect') {
      fctx.rect(sx, sy, sw, sh);
      fctx.stroke();
    } else if (s.type === 'ellipse') {
      fctx.ellipse(cx, cy, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      fctx.stroke();
    } else if (s.type === 'line' || s.type === 'arrow') {
      var lx1 = s.start.x - sel.x, ly1 = s.start.y - sel.y;
      var lx2 = s.end.x - sel.x, ly2 = s.end.y - sel.y;
      fctx.moveTo(lx1, ly1);
      fctx.lineTo(lx2, ly2);
      fctx.stroke();
      if (s.type === 'arrow') {
        var angle = Math.atan2(ly2 - ly1, lx2 - lx1);
        var headLen = 12;
        var headAngle = 0.5;
        fctx.beginPath();
        fctx.moveTo(lx2, ly2);
        fctx.lineTo(lx2 - headLen * Math.cos(angle - headAngle), ly2 - headLen * Math.sin(angle - headAngle));
        fctx.moveTo(lx2, ly2);
        fctx.lineTo(lx2 - headLen * Math.cos(angle + headAngle), ly2 - headLen * Math.sin(angle + headAngle));
        fctx.stroke();
      }
    }

    fctx.globalAlpha = 1;
    fctx.restore();
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
      ox * dpr, oy * dpr, ow * dpr, oh * dpr, // source (physical pixels)
      ox - sel.x, oy - sel.y, ow, oh           // dest (CSS px, scaled by dpr)
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
    state.currentStroke = { type: 'pencil', color: state.pencilColor, width: state.pencilWidth, points: [{ x: mx, y: my }] };
    state.annotations.push(state.currentStroke);
    render();
    return;
  }

  if (state.currentTool === 'shape' && state.sel) {
    state.redoStack = [];
    state.shapeStart = { x: mx, y: my };
    state.currentStroke = {
      type: state.shapeType,
      color: state.shapeStrokeColor,
      strokeOpacity: state.shapeStrokeOpacity,
      fillColor: state.shapeFillColor,
      fillOpacity: state.shapeFillOpacity,
      width: 2,
      start: { x: mx, y: my }, end: { x: mx, y: my }
    };
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

  // Shape drawing (update end point for all shape types)
  if (state.currentStroke && state.shapeStart && state.currentStroke.end) {
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

  // Show/hide shape toolbar
  if (tool === 'shape') {
    positionShapeToolbar();
    shapeToolbar.style.display = 'flex';
  } else {
    shapeToolbar.style.display = 'none';
    fillPopup.style.display = 'none';
    strokePopup.style.display = 'none';
  }
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

// ─── Shape toolbar positioning ─────────────────────────────────────────────

function positionShapeToolbar() {
  var sel = state.sel;
  if (!sel || sel.w <= 0 || sel.h <= 0) return;

  // Make visible first so offsetWidth/Height are valid
  shapeToolbar.style.display = 'flex';

  var tbW = shapeToolbar.offsetWidth || 220;
  var tbH = shapeToolbar.offsetHeight || 36;
  var sw = state.screenW;
  var sh = state.screenH;

  // Center on selection horizontally
  var cx = sel.x + sel.w / 2;
  var tx = Math.max(4, Math.min(sw - tbW - 4, cx - tbW / 2));

  // Try placing BELOW the main toolbar first, then above
  var mainTbRect = toolbar.getBoundingClientRect();
  var ty = mainTbRect.bottom + 4;
  if (ty + tbH > sh - 4) {
    ty = mainTbRect.top - tbH - 4;
  }
  if (ty < 4) {
    ty = Math.max(4, sel.y - tbH - 4);
  }

  shapeToolbar.style.left = tx + 'px';
  shapeToolbar.style.top = ty + 'px';
}

// ─── Generic popup positioning ─────────────────────────────────────────────

function positionPopup(popup, anchorEl) {
  popup.style.display = 'flex';
  var anchorRect = anchorEl.getBoundingClientRect();
  var popW = popup.offsetWidth || 200;
  var popH = popup.offsetHeight || 120;
  var sw = state.screenW;
  var sh = state.screenH;

  // Center on anchor button horizontally
  var px = anchorRect.left + anchorRect.width / 2 - popW / 2;
  // Place below anchor
  var py = anchorRect.bottom + 4;

  px = Math.max(4, Math.min(sw - popW - 4, px));
  if (py + popH > sh - 4) {
    py = anchorRect.top - popH - 4;
  }

  popup.style.left = px + 'px';
  popup.style.top = py + 'px';
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
  pencilSettings = document.getElementById('pencilSettings');

  // Listen for capture start from main process
  window.regionCaptureAPI.onCaptureStart(function(data) {
    state.screenW = data.screenBounds.width;
    state.screenH = data.screenBounds.height;
    var dpr = data.dpr || 1;

    // Set canvas to physical pixel dimensions for sharp rendering
    // Use CSS to constrain display size to the window
    canvas.width = Math.round(data.screenBounds.width * dpr);
    canvas.height = Math.round(data.screenBounds.height * dpr);
    canvas.style.width = data.screenBounds.width + 'px';
    canvas.style.height = data.screenBounds.height + 'px';

    // Scale context so all drawing uses CSS pixel coordinates
    // (mouse events also use CSS pixels, matching perfectly)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
      } else if (tool === 'pencil' && state.currentTool === 'pencil') {
        // Already in pencil mode → toggle settings panel
        togglePencilSettings();
      } else {
        pencilSettings.style.display = 'none';
        selectTool(tool);
      }
    });
  });

  // Pencil settings: color swatches
  pencilSettings.querySelectorAll('.color-swatch').forEach(function(el) {
    el.addEventListener('click', function() {
      pencilSettings.querySelectorAll('.color-swatch').forEach(function(s) { s.classList.remove('active'); });
      this.classList.add('active');
      state.pencilColor = this.getAttribute('data-color');
      // Update the pencil button's active color indicator
      var pencilBtn = toolbar.querySelector('[data-tool="pencil"]');
      if (pencilBtn) pencilBtn.style.color = state.pencilColor;
    });
  });

  // Pencil settings: width samples
  pencilSettings.querySelectorAll('.width-sample').forEach(function(el) {
    el.addEventListener('click', function() {
      pencilSettings.querySelectorAll('.width-sample').forEach(function(s) { s.classList.remove('active'); });
      this.classList.add('active');
      state.pencilWidth = parseInt(this.getAttribute('data-width'));
    });
  });

  // ── Shape toolbar ──
  shapeToolbar = document.getElementById('shapeToolbar');
  fillPopup = document.getElementById('fillPopup');
  strokePopup = document.getElementById('strokePopup');
  shapeToolbar.style.display = 'none';
  fillPopup.style.display = 'none';
  strokePopup.style.display = 'none';

  // Initial fill button state (default shape is rect → fill enabled)
  document.getElementById('shapeFillBtn').style.opacity = '1';
  document.getElementById('shapeFillBtn').style.cursor = 'pointer';

  // Shape type buttons
  shapeToolbar.querySelectorAll('[data-shape]').forEach(function(btn) {
    btn.addEventListener('click', function() {
      shapeToolbar.querySelectorAll('[data-shape]').forEach(function(b) { b.classList.remove('active'); });
      this.classList.add('active');
      state.shapeType = this.getAttribute('data-shape');
      // Enable/disable fill button based on shape type
      var fillBtn = document.getElementById('shapeFillBtn');
      if (state.shapeType === 'rect' || state.shapeType === 'ellipse') {
        fillBtn.style.opacity = '1';
        fillBtn.style.cursor = 'pointer';
      } else {
        fillBtn.style.opacity = '0.4';
        fillBtn.style.cursor = 'default';
      }
    });
  });

  // Fill button → toggle fill popup
  document.getElementById('shapeFillBtn').addEventListener('click', function() {
    if (state.shapeType !== 'rect' && state.shapeType !== 'ellipse') return;
    strokePopup.style.display = 'none';
    if (fillPopup.style.display === 'flex') {
      fillPopup.style.display = 'none';
    } else {
      positionPopup(fillPopup, this);
    }
  });

  // Stroke button → toggle stroke popup
  document.getElementById('shapeStrokeBtn').addEventListener('click', function() {
    fillPopup.style.display = 'none';
    if (strokePopup.style.display === 'flex') {
      strokePopup.style.display = 'none';
    } else {
      positionPopup(strokePopup, this);
    }
  });

  // Fill popup: None button
  document.getElementById('fillNone').addEventListener('click', function() {
    fillPopup.querySelectorAll('.swatch-none, .swatch').forEach(function(el) { el.classList.remove('active'); });
    this.classList.add('active');
    state.shapeFillColor = null;
    document.getElementById('fillPreview').style.background = 'transparent';
  });

  // Fill popup: color swatches
  fillPopup.querySelectorAll('.swatch').forEach(function(el) {
    el.addEventListener('click', function() {
      fillPopup.querySelectorAll('.swatch-none, .swatch').forEach(function(s) { s.classList.remove('active'); });
      this.classList.add('active');
      state.shapeFillColor = this.getAttribute('data-fill');
      var opacity = parseInt(document.getElementById('fillOpacity').value) / 100;
      document.getElementById('fillPreview').style.background = state.shapeFillColor;
      document.getElementById('fillPreview').style.opacity = opacity;
    });
  });

  // Fill opacity slider
  document.getElementById('fillOpacity').addEventListener('input', function() {
    var val = parseInt(this.value);
    document.getElementById('fillOpacityVal').textContent = val + '%';
    state.shapeFillOpacity = val / 100;
    if (state.shapeFillColor) {
      document.getElementById('fillPreview').style.opacity = val / 100;
    }
  });

  // Stroke popup: None button
  document.getElementById('strokeNone').addEventListener('click', function() {
    strokePopup.querySelectorAll('.swatch-none, .swatch').forEach(function(el) { el.classList.remove('active'); });
    this.classList.add('active');
    state.shapeStrokeColor = null;
    document.getElementById('strokePreview').style.background = 'transparent';
  });

  // Stroke popup: color swatches
  strokePopup.querySelectorAll('.swatch').forEach(function(el) {
    el.addEventListener('click', function() {
      strokePopup.querySelectorAll('.swatch-none, .swatch').forEach(function(s) { s.classList.remove('active'); });
      this.classList.add('active');
      state.shapeStrokeColor = this.getAttribute('data-stroke');
      var opacity = parseInt(document.getElementById('strokeOpacity').value) / 100;
      document.getElementById('strokePreview').style.background = state.shapeStrokeColor;
      document.getElementById('strokePreview').style.opacity = opacity;
    });
  });

  // Stroke opacity slider
  document.getElementById('strokeOpacity').addEventListener('input', function() {
    var val = parseInt(this.value);
    document.getElementById('strokeOpacityVal').textContent = val + '%';
    state.shapeStrokeOpacity = val / 100;
    if (state.shapeStrokeColor) {
      document.getElementById('strokePreview').style.opacity = val / 100;
    }
  });

  // Close fill/stroke popups when clicking outside
  document.addEventListener('mousedown', function(e) {
    if (pencilSettings.style.display !== 'none') {
      var target = e.target;
      if (!pencilSettings.contains(target) && !toolbar.contains(target)) {
        pencilSettings.style.display = 'none';
      }
    }
    if (fillPopup.style.display === 'flex') {
      var target = e.target;
      if (!fillPopup.contains(target) && target.id !== 'shapeFillBtn' && !target.closest('#shapeFillBtn')) {
        fillPopup.style.display = 'none';
      }
    }
    if (strokePopup.style.display === 'flex') {
      var target = e.target;
      if (!strokePopup.contains(target) && target.id !== 'shapeStrokeBtn' && !target.closest('#shapeStrokeBtn')) {
        strokePopup.style.display = 'none';
      }
    }
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
    if (e.key === 'Escape') {
      if (pencilSettings.style.display !== 'none') {
        pencilSettings.style.display = 'none';
      } else if (fillPopup.style.display === 'flex') {
        fillPopup.style.display = 'none';
      } else if (strokePopup.style.display === 'flex') {
        strokePopup.style.display = 'none';
      } else {
        onCancel();
      }
    }
  });
});

// ─── Pencil settings toggle & position ─────────────────────────────────────

function togglePencilSettings() {
  if (pencilSettings.style.display === 'none' || pencilSettings.style.display === '') {
    showPencilSettings();
  } else {
    pencilSettings.style.display = 'none';
  }
}

function showPencilSettings() {
  pencilSettings.style.display = 'flex';

  // Position the settings panel below the toolbar, aligned with the pencil button
  var tbRect = toolbar.getBoundingClientRect();
  var pencilBtn = toolbar.querySelector('[data-tool="pencil"]');
  var btnRect = pencilBtn ? pencilBtn.getBoundingClientRect() : tbRect;

  var panelW = pencilSettings.offsetWidth || 200;
  var panelH = pencilSettings.offsetHeight || 80;
  var sw = state.screenW;
  var sh = state.screenH;

  // Center the panel on the pencil button horizontally
  var px = btnRect.left + btnRect.width / 2 - panelW / 2;
  // Place below the toolbar
  var py = tbRect.bottom + 4;

  // Clamp to screen
  px = Math.max(4, Math.min(sw - panelW - 4, px));
  if (py + panelH > sh - 4) {
    py = tbRect.top - panelH - 4;
  }

  pencilSettings.style.left = px + 'px';
  pencilSettings.style.top = py + 'px';
}
