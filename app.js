// ===== FillablePDF — client-side fillable PDF designer =====
// Loads a PDF (or a blank page), lets you place AcroForm fields over it,
// and exports a real fillable PDF using pdf-lib. Everything runs in the
// browser; no file ever leaves the device.
(function () {
    'use strict';

    var PDFLib = window.PDFLib;
    var pdfjsLib = window.pdfjsLib;

    if (pdfjsLib) {
        // Worker is bundled locally next to this file.
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
    }

    // ─────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────
    var APP_VERSION = 'v0.1';

    var PAGE_SIZES = {
        letter: [612, 792],
        legal: [612, 1008],
        a4: [595.28, 841.89]
    };

    var FIELD_TYPES = {
        text:      { label: 'Text field',      w: 170, h: 24, value: true,  options: false, group: false, check: false },
        textarea:  { label: 'Multiline text',  w: 220, h: 76, value: true,  options: false, group: false, check: false },
        date:      { label: 'Date field',      w: 130, h: 24, value: true,  options: false, group: false, check: false },
        checkbox:  { label: 'Checkbox',        w: 20,  h: 20, value: false, options: false, group: false, check: true  },
        radio:     { label: 'Radio button',    w: 20,  h: 20, value: false, options: false, group: true,  check: true  },
        dropdown:  { label: 'Dropdown',        w: 160, h: 26, value: true,  options: true,  group: false, check: false },
        signature: { label: 'Signature line',  w: 200, h: 40, value: true,  options: false, group: false, check: false }
    };

    var ALIGN_MAP = { left: 0, center: 1, right: 2 };

    // ─────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────
    var state = {
        name: 'Untitled',
        prefix: 'field',
        tool: 'select',
        selectedId: null,
        fields: [],
        flatten: false
    };

    var pdfBytes = null;       // Uint8Array of the source PDF
    var pdfjsDoc = null;       // pdf.js document proxy
    var pageViews = [];        // per-page render records
    var scale = 1;
    var dpr = Math.max(1, window.devicePixelRatio || 1);

    var undoStack = [];
    var redoStack = [];
    var MAX_UNDO = 100;
    var idCounter = 1;

    var pendingDrag = null;    // active pointer interaction

    // ─────────────────────────────────────────────────────────────
    // DOM
    // ─────────────────────────────────────────────────────────────
    var $ = function (id) { return document.getElementById(id); };

    var pagesLayer = $('pages-layer');
    var canvasContainer = $('canvas-container');
    var startOverlay = $('start-overlay');
    var layerList = $('layer-list');
    var logBody = $('log-body');

    // ─────────────────────────────────────────────────────────────
    // Small utilities
    // ─────────────────────────────────────────────────────────────
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

    function el(tag, cls, parent) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (parent) parent.appendChild(e);
        return e;
    }

    function hexToRgb(hex) {
        hex = String(hex || '#000000').replace('#', '');
        if (hex.length === 3) hex = hex.split('').map(function (c) { return c + c; }).join('');
        var n = parseInt(hex, 16);
        if (isNaN(n)) n = 0;
        return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
    }

    function bytesToBase64(bytes) {
        var chunk = 0x8000, out = '';
        for (var i = 0; i < bytes.length; i += chunk) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(out);
    }

    function base64ToBytes(b64) {
        var bin = atob(b64), len = bin.length, bytes = new Uint8Array(len);
        for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
    }

    function sanitizeName(name, fallback) {
        var s = String(name || '').trim();
        if (!s) s = fallback || 'field';
        s = s.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '');
        if (!s) s = 'field';
        if (/^\d/.test(s)) s = 'f_' + s;
        return s;
    }

    function toast(msg, kind) {
        var t = $('toast');
        if (!t) {
            t = el('div', '', document.body);
            t.id = 'toast';
        }
        t.textContent = msg;
        t.className = 'visible' + (kind === 'error' ? ' error' : kind === 'success' ? ' success' : '');
        clearTimeout(toast._t);
        toast._t = setTimeout(function () { t.className = ''; }, 3600);
    }

    function busy(on, msg) {
        var o = $('busy-overlay');
        if (!o) {
            o = el('div', 'hidden', document.body);
            o.id = 'busy-overlay';
            o.innerHTML = '<div class="spinner"></div><span class="busy-msg"></span>';
            o.style.display = 'none';
        }
        if (msg) o.querySelector('.busy-msg').textContent = msg;
        o.classList.toggle('hidden', !on);
        o.style.display = on ? 'flex' : 'none';
    }

    function triggerAutoSave() {
        if (typeof window.triggerAutoSave === 'function') window.triggerAutoSave();
    }

    function logAction(msg, type) {
        var body = document.getElementById('log-body');
        if (!body) return;
        var now = new Date();
        var ts = String(now.getHours()).padStart(2, '0') + ':' +
                 String(now.getMinutes()).padStart(2, '0') + ':' +
                 String(now.getSeconds()).padStart(2, '0');
        var entry = el('div', 'log-entry', body);
        entry.innerHTML = '<span class="log-time">' + ts + '</span><span class="log-' + (type || 'sys') + '">' +
            escapeHtml(msg) + '</span>';
        body.scrollTop = body.scrollHeight;
    }

    // ─────────────────────────────────────────────────────────────
    // Loading documents
    // ─────────────────────────────────────────────────────────────
    function destroyDocument() {
        if (pdfjsDoc) {
            try { pdfjsDoc.destroy(); } catch (e) {}
            pdfjsDoc = null;
        }
        pagesLayer.innerHTML = '';
        pageViews = [];
    }

    function loadPdfBytes(bytes, displayName, opts) {
        opts = opts || {};
        busy(true, 'Rendering PDF…');
        destroyDocument();
        pdfBytes = bytes;

        return pdfjsLib.getDocument({ data: bytes.slice(0), disableAutoFetch: true }).promise.then(function (doc) {
            pdfjsDoc = doc;
            state.name = displayName || 'Untitled';
            if (!opts.keepFields) {
                state.fields = [];
                state.selectedId = null;
                idCounter = 1;
                undoStack = [];
                redoStack = [];
            }
            if (startOverlay) startOverlay.classList.add('hidden');
            return renderPages();
        }).then(function () {
            busy(false);
            if (!opts.keepFields) selectField(null);
            syncDocumentPanel();
            updateUndoButtons();
            if (!opts.silent) toast('Loaded ' + (displayName || 'document'), 'success');
            logAction('Loaded ' + (displayName || 'document') + ' (' + pdfjsDoc.numPages + ' page' + (pdfjsDoc.numPages === 1 ? '' : 's') + ')', 'add');
            return pdfjsDoc;
        }).catch(function (err) {
            busy(false);
            console.error(err);
            toast('Could not open PDF: ' + (err && err.message ? err.message : err), 'error');
            return null;
        });
    }

    function newBlankDocument(sizeKey) {
        var size = PAGE_SIZES[sizeKey] || PAGE_SIZES.letter;
        busy(true, 'Creating document…');
        PDFLib.PDFDocument.create().then(function (doc) {
            doc.addPage(size);
            return doc.save();
        }).then(function (bytes) {
            loadPdfBytes(bytes, 'Untitled', {});
        }).catch(function (err) {
            busy(false);
            console.error(err);
            toast('Could not create document', 'error');
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────
    function renderPages() {
        pagesLayer.innerHTML = '';
        pageViews = [];
        var chain = Promise.resolve();

        // Build sequentially to limit memory pressure.
        for (var num = 1; num <= pdfjsDoc.numPages; num++) {
            chain = chain.then(makePageRenderer(num));
        }
        return chain;
    }

    function makePageRenderer(num) {
        return function () {
            return pdfjsDoc.getPage(num).then(function (page) {
                var viewport = page.getViewport({ scale: scale });
                var wrap = el('div', 'pdf-page', pagesLayer);
                wrap.style.width = viewport.width + 'px';
                wrap.style.height = viewport.height + 'px';

                var canvas = el('canvas', '', wrap);
                canvas.width = Math.floor(viewport.width * dpr);
                canvas.height = Math.floor(viewport.height * dpr);
                canvas.style.width = viewport.width + 'px';
                canvas.style.height = viewport.height + 'px';
                var ctx = canvas.getContext('2d');

                var layer = el('div', 'page-field-layer', wrap);
                layer.style.width = viewport.width + 'px';
                layer.style.height = viewport.height + 'px';

                var numEl = el('div', 'page-number', wrap);
                numEl.textContent = 'Page ' + num;

                var vp1 = page.getViewport({ scale: 1 });
                var rec = {
                    num: num,
                    page: page,
                    viewport: viewport,
                    vp1: vp1,
                    wrap: wrap,
                    layer: layer
                };
                pageViews.push(rec);

                var renderTask = page.render({
                    canvasContext: ctx,
                    viewport: viewport,
                    transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
                });
                return renderTask.promise.then(function () {
                    renderFieldsFor(rec);
                });
            });
        };
    }

    function pageView(num) { return pageViews[num - 1]; }

    // Screen geometry helpers ------------------------------------------------
    function screenDimsForPoints(vp, w, h) {
        var a = vp.convertToViewportPoint(0, 0);
        var b = vp.convertToViewportPoint(w, h);
        return { w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
    }

    function pdfRectFromScreen(vp, left, top, w, h) {
        var pts = [
            vp.convertToPdfPoint(left, top),
            vp.convertToPdfPoint(left + w, top),
            vp.convertToPdfPoint(left, top + h),
            vp.convertToPdfPoint(left + w, top + h)
        ];
        var xs = pts.map(function (p) { return p[0]; });
        var ys = pts.map(function (p) { return p[1]; });
        var minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
        return {
            x: minX,
            y: minY,
            w: Math.max.apply(null, xs) - minX,
            h: Math.max.apply(null, ys) - minY
        };
    }

    function layoutFieldEl(f, node) {
        var rec = pageView(f.page);
        if (!rec || !node) return;
        var vp = rec.viewport;
        var p1 = vp.convertToViewportPoint(f.x, f.y);
        var p2 = vp.convertToViewportPoint(f.x + f.w, f.y + f.h);
        var left = Math.min(p1[0], p2[0]);
        var top = Math.min(p1[1], p2[1]);
        var w = Math.abs(p2[0] - p1[0]);
        var h = Math.abs(p2[1] - p1[1]);
        node.style.left = left + 'px';
        node.style.top = top + 'px';
        node.style.width = Math.max(6, w) + 'px';
        node.style.height = Math.max(6, h) + 'px';
    }

    // Field rendering --------------------------------------------------------
    function fieldPreviewHTML(f) {
        var alignCls = f.align === 'center' ? ' align-center' : f.align === 'right' ? ' align-right' : '';
        if (f.type === 'checkbox') {
            var checked = isTruthy(f.value);
            return '<span class="field-preview' + alignCls + '">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2">' +
                '<rect x="2" y="2" width="20" height="20" rx="3"/>' +
                (checked ? '<polyline points="6 12 10 16 18 8"/>' : '') +
                '</svg></span>';
        }
        if (f.type === 'radio') {
            var on = isTruthy(f.value);
            return '<span class="field-preview' + alignCls + '">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="#374151" stroke-width="2">' +
                '<circle cx="12" cy="12" r="10"/>' +
                (on ? '<circle cx="12" cy="12" r="4.5" fill="#374151" stroke="none"/>' : '') +
                '</svg></span>';
        }
        if (f.type === 'dropdown') {
            return '<span class="field-preview' + alignCls + '">' + escapeHtml(f.value || (f.options[0] || '')) +
                '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#6b7280" stroke-width="2" style="margin-left:auto">' +
                '<polyline points="6 9 12 15 18 9"/></svg></span>';
        }
        var text = f.value || (f.type === 'date' ? 'MM / DD / YYYY' : f.type === 'signature' ? 'Sign here' : '');
        if (!text) text = f.name || FIELD_TYPES[f.type].label;
        return '<span class="field-preview' + alignCls + '">' + escapeHtml(text) + '</span>';
    }

    function escapeHtml(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function isTruthy(v) {
        if (v === true) return true;
        if (v == null) return false;
        var s = String(v).toLowerCase().trim();
        return s !== '' && s !== '0' && s !== 'false' && s !== 'no' && s !== 'off';
    }

    function createFieldNode(f) {
        var node = el('div', 'field type-' + f.type);
        node.dataset.id = f.id;
        node.innerHTML = '<span class="field-badge"></span>' + fieldPreviewHTML(f);
        node.querySelector('.field-badge').textContent = f.name || FIELD_TYPES[f.type].label;

        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (dir) {
            var h = el('div', 'field-handle ' + dir, node);
            h.dataset.dir = dir;
        });
        layoutFieldEl(f, node);
        return node;
    }

    function renderFieldsFor(rec) {
        rec.layer.innerHTML = '';
        state.fields.forEach(function (f) {
            if (f.page !== rec.num) return;
            var node = createFieldNode(f);
            if (f.id === state.selectedId) node.classList.add('selected');
            rec.layer.appendChild(node);
        });
    }

    function renderFields() {
        pageViews.forEach(function (rec) { renderFieldsFor(rec); });
        updateLayerList();
        syncSelectionSections();
    }

    // ─────────────────────────────────────────────────────────────
    // Selection
    // ─────────────────────────────────────────────────────────────
    function getSelected() {
        if (!state.selectedId) return null;
        for (var i = 0; i < state.fields.length; i++) {
            if (state.fields[i].id === state.selectedId) return state.fields[i];
        }
        return null;
    }

    function selectField(id) {
        state.selectedId = id || null;
        pageViews.forEach(function (rec) {
            var nodes = rec.layer.querySelectorAll('.field');
            Array.prototype.forEach.call(nodes, function (n) {
                n.classList.toggle('selected', n.dataset.id === state.selectedId);
            });
        });
        updateLayerListActive();
        syncFieldPanel();
    }

    function updateLayerListActive() {
        if (!layerList) return;
        Array.prototype.forEach.call(layerList.querySelectorAll('.layer-item'), function (item) {
            item.classList.toggle('active', item.dataset.id === state.selectedId);
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Field CRUD
    // ─────────────────────────────────────────────────────────────
    function nextFieldName(type) {
        return (state.prefix || 'field') + '_' + (idCounter++);
    }

    function makeField(type, page, rect) {
        var meta = FIELD_TYPES[type];
        var f = {
            id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
            type: type,
            name: nextFieldName(type),
            page: page,
            x: rect.x, y: rect.y, w: rect.w, h: rect.h,
            value: '',
            required: false,
            readonly: false,
            options: [],
            group: '',
            radioValue: '',
            fontSize: type === 'checkbox' || type === 'radio' ? 12 : 12,
            align: 'left',
            textColor: '#111113',
            borderColor: '#6b7280',
            borderWidth: 1,
            fillColor: '#ffffff'
        };
        if (type === 'dropdown') { f.options = []; }
        if (type === 'signature') { f.value = ''; }
        return f;
    }

    function addFieldAt(type, rec, px, py) {
        var meta = FIELD_TYPES[type];
        var dims = screenDimsForPoints(rec.viewport, meta.w, meta.h);
        var left = px - dims.w / 2;
        var top = py - dims.h / 2;
        var rect = pdfRectFromScreen(rec.viewport, left, top, dims.w, dims.h);
        rect.w = Math.max(8, rect.w);
        rect.h = Math.max(8, rect.h);

        pushUndo();
        var f = makeField(type, rec.num, rect);
        state.fields.push(f);
        renderFields();
        selectField(f.id);
        triggerAutoSave();
        logAction(FIELD_TYPES[type].label + ' added on page ' + rec.num, 'add');
        toast(FIELD_TYPES[type].label + ' added on page ' + rec.num);
    }

    function deleteSelected() {
        var f = getSelected();
        if (!f) return;
        pushUndo();
        state.fields = state.fields.filter(function (x) { return x.id !== f.id; });
        state.selectedId = null;
        renderFields();
        triggerAutoSave();
        logAction('Deleted ' + f.name, 'del');
    }

    function duplicateSelected() {
        var f = getSelected();
        if (!f) return;
        pushUndo();
        var copy = JSON.parse(JSON.stringify(f));
        copy.id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        copy.name = uniqueFieldName(f.name + '_copy');
        copy.x += 12; copy.y -= 12;
        state.fields.push(copy);
        renderFields();
        selectField(copy.id);
        triggerAutoSave();
        logAction('Duplicated ' + f.name, 'add');
    }

    function reorderField(f, dir) {
        var i = state.fields.indexOf(f);
        var j = i + dir;
        if (i === -1 || j < 0 || j >= state.fields.length) return;
        pushUndo();
        state.fields.splice(i, 1);
        state.fields.splice(j, 0, f);
        renderFields();
        triggerAutoSave();
    }

    function uniqueFieldName(base, excludeId) {
        var names = {};
        state.fields.forEach(function (f) { if (f.id !== excludeId) names[f.name] = true; });
        var name = base, i = 2;
        while (names[name]) { name = base + '_' + i; i++; }
        return name;
    }

    // ─────────────────────────────────────────────────────────────
    // Undo / redo
    // ─────────────────────────────────────────────────────────────
    function snapshot() {
        return JSON.stringify({
            fields: state.fields,
            name: state.name,
            prefix: state.prefix,
            selectedId: state.selectedId
        });
    }

    function pushUndo() {
        undoStack.push(snapshot());
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
        updateUndoButtons();
    }

    function restoreSnapshot(str) {
        var s = JSON.parse(str);
        state.fields = s.fields || [];
        state.name = s.name || 'Untitled';
        state.prefix = s.prefix || 'field';
        state.selectedId = s.selectedId || null;
        var pn = $('project-name');
        if (pn) pn.value = state.name;
        renderFields();
        syncFieldPanel();
        syncDocumentPanel();
        triggerAutoSave();
    }

    function undo() {
        if (!undoStack.length) return;
        redoStack.push(snapshot());
        restoreSnapshot(undoStack.pop());
        updateUndoButtons();
    }

    function redo() {
        if (!redoStack.length) return;
        undoStack.push(snapshot());
        restoreSnapshot(redoStack.pop());
        updateUndoButtons();
    }

    function updateUndoButtons() {
        var u = $('btn-undo'), r = $('btn-redo');
        if (u) u.disabled = !undoStack.length;
        if (r) r.disabled = !redoStack.length;
    }

    // ─────────────────────────────────────────────────────────────
    // Pointer interaction (drag / resize / place)
    // ─────────────────────────────────────────────────────────────
    function localPoint(e, node) {
        var r = node.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function onPointerDown(e) {
        if (window._readOnly) return;
        if (e.button !== undefined && e.button !== 0) return;

        var handle = e.target.closest('.field-handle');
        var fieldNode = e.target.closest('.field');

        if (handle && fieldNode) { startResize(e, handle.dataset.dir, fieldNode); return; }
        if (fieldNode) {
            var id = fieldNode.dataset.id;
            if (state.tool !== 'select') setTool('select');
            if (state.selectedId !== id) selectField(id);
            startDrag(e, fieldNode);
            return;
        }

        var layer = e.target.closest('.page-field-layer');
        if (!layer) return;

        if (state.tool === 'select') {
            selectField(null);
            return;
        }
        var rec = null;
        var pageNum = null;
        for (var i = 0; i < pageViews.length; i++) {
            if (pageViews[i].layer === layer) { rec = pageViews[i]; pageNum = pageViews[i].num; break; }
        }
        if (!rec) return;
        var p = localPoint(e, layer);
        addFieldAt(state.tool, rec, p.x, p.y);
    }

    function startDrag(e, fieldNode) {
        var f = getSelected();
        if (!f) return;
        var rec = pageView(f.page);
        if (!rec) return;
        e.preventDefault();
        pushUndo();
        var start = localPoint(e, rec.layer);
        var startPdf = rec.viewport.convertToPdfPoint(start.x, start.y);
        pendingDrag = {
            mode: 'move',
            f: f,
            node: fieldNode,
            rec: rec,
            startPdf: startPdf,
            orig: { x: f.x, y: f.y, w: f.w, h: f.h }
        };
        fieldNode.setPointerCapture && fieldNode.setPointerCapture(e.pointerId);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    }

    function startResize(e, dir, fieldNode) {
        var f = getSelected();
        if (!f) return;
        var rec = pageView(f.page);
        if (!rec) return;
        e.preventDefault();
        e.stopPropagation();
        pushUndo();
        var start = localPoint(e, rec.layer);
        var startPdf = rec.viewport.convertToPdfPoint(start.x, start.y);
        pendingDrag = {
            mode: 'resize',
            dir: dir,
            f: f,
            node: fieldNode,
            rec: rec,
            startPdf: startPdf,
            orig: { x: f.x, y: f.y, w: f.w, h: f.h }
        };
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
    }

    function onPointerMove(e) {
        if (!pendingDrag) return;
        e.preventDefault();
        var d = pendingDrag;
        var p = localPoint(e, d.rec.layer);
        var curPdf = d.rec.viewport.convertToPdfPoint(p.x, p.y);
        var dx = curPdf[0] - d.startPdf[0];
        var dy = curPdf[1] - d.startPdf[1];
        var f = d.f, o = d.orig;

        if (d.mode === 'move') {
            f.x = o.x + dx;
            f.y = o.y + dy;
        } else {
            var x1 = o.x, y1 = o.y, x2 = o.x + o.w, y2 = o.y + o.h;
            if (d.dir.indexOf('w') !== -1) x1 = o.x + dx;
            if (d.dir.indexOf('e') !== -1) x2 = o.x + o.w + dx;
            if (d.dir.indexOf('s') !== -1) y1 = o.y + dy;
            if (d.dir.indexOf('n') !== -1) y2 = o.y + o.h + dy;
            if (e.shiftKey) {
                // keep aspect ratio for corner handles (roughly)
                if (d.dir.length === 2) {
                    var ratio = o.h / o.w;
                    var newW = Math.abs(x2 - x1), newH = Math.abs(y2 - y1);
                    if (newW * ratio > newH) {
                        newH = newW * ratio;
                        if (y2 > y1) y2 = y1 + newH; else y1 = y2 - newH;
                    } else {
                        newW = newH / ratio;
                        if (x2 > x1) x2 = x1 + newW; else x1 = x2 - newW;
                    }
                }
            }
            f.x = Math.min(x1, x2);
            f.y = Math.min(y1, y2);
            f.w = Math.max(6, Math.abs(x2 - x1));
            f.h = Math.max(6, Math.abs(y2 - y1));
        }
        layoutFieldEl(f, d.node);
        syncGeometryInputs(f);
    }

    function onPointerUp() {
        if (!pendingDrag) return;
        var d = pendingDrag;
        pendingDrag = null;
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        triggerAutoSave();
        updateLayerList();
    }

    // ─────────────────────────────────────────────────────────────
    // Properties panel
    // ─────────────────────────────────────────────────────────────
    function showSections(show) {
        ['sec-name', 'sec-geometry', 'sec-value', 'sec-style'].forEach(function (id) {
            var n = $(id);
            if (n) n.style.display = show ? '' : 'none';
        });
        var proj = $('sec-project');
        if (proj) proj.style.display = show ? 'none' : '';
    }

    function syncSelectionSections() { showSections(!!getSelected()); }

    function setVal(id, v) {
        var n = $(id);
        if (n && document.activeElement !== n) n.value = v == null ? '' : v;
    }
    function setChk(id, v) {
        var n = $(id);
        if (n) n.checked = !!v;
    }

    function syncGeometryInputs(f) {
        if (!f) return;
        setVal('prop-page', f.page);
        setVal('prop-x', Math.round(f.x));
        setVal('prop-y', Math.round(f.y));
        setVal('prop-width', Math.round(f.w));
        setVal('prop-height', Math.round(f.h));
        var info = $('prop-size-info');
        if (info) info.textContent = 'Position in PDF points (origin bottom-left)';
    }

    function syncFieldPanel() {
        var f = getSelected();
        syncSelectionSections();
        if (!f) return;
        setVal('prop-name', f.name);
        setVal('prop-type', FIELD_TYPES[f.type].label);
        syncGeometryInputs(f);

        var meta = FIELD_TYPES[f.type];
        setRow('row-default', meta.value);
        setRow('row-options', meta.options);
        setRow('row-group', meta.group);
        setRow('row-radio-value', meta.group);
        setRow('row-checked', meta.check);

        setVal('prop-default', f.value);
        setVal('prop-options', (f.options || []).join('\n'));
        setVal('prop-group', f.group);
        setVal('prop-radio-value', f.radioValue);
        setChk('prop-checked', isTruthy(f.value));
        setChk('prop-required', f.required);
        setChk('prop-readonly', f.readonly);

        setVal('prop-fontSize', f.fontSize);
        setVal('prop-borderWidth', f.borderWidth);
        setVal('prop-textColor', f.textColor);
        setVal('prop-borderColor', f.borderColor);
        setVal('prop-fill', f.fillColor);
        setVal('prop-align', f.align);
    }

    function setRow(id, show) {
        var n = $(id);
        if (n) n.style.display = show ? '' : 'none';
    }

    function syncDocumentPanel() {
        setVal('doc-pages', pageViews.length);
        setVal('doc-fields', state.fields.length);
        setVal('project-name', state.name);
        setVal('doc-prefix', state.prefix);
        setChk('export-flatten', state.flatten);
    }

    // Apply a property change coming from ui.js (geometry / name)
    window.onPropChange = function (prop, value) {
        var f = getSelected();
        if (!f) return;
        pushUndo();
        switch (prop) {
            case 'name': f.name = uniqueFieldName(value || 'field', f.id); break;
            case 'x': f.x = Number(value) || 0; break;
            case 'y': f.y = Number(value) || 0; break;
            case 'width': f.w = Math.max(4, Number(value) || 4); break;
            case 'height': f.h = Math.max(4, Number(value) || 4); break;
        }
        renderFields();
        triggerAutoSave();
    };

    function bindPanelInputs() {
        function on(id, ev, fn) {
            var n = $(id);
            if (n) n.addEventListener(ev, fn);
        }
        function commit(fn) {
            return function () {
                var f = getSelected();
                if (!f) return;
                pushUndo();
                fn(f, this);
                renderFields();
                syncFieldPanel();
                triggerAutoSave();
            };
        }

        on('prop-page', 'change', commit(function (f, n) {
            var p = clamp(parseInt(n.value, 10) || 1, 1, pageViews.length);
            f.page = p;
            n.value = p;
        }));

        on('prop-default', 'change', commit(function (f, n) { f.value = n.value; }));
        on('prop-options', 'change', commit(function (f, n) {
            f.options = n.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
            if (f.options.indexOf(f.value) === -1) f.value = f.options[0] || '';
        }));
        on('prop-group', 'change', commit(function (f, n) { f.group = n.value.trim(); }));
        on('prop-radio-value', 'change', commit(function (f, n) { f.radioValue = n.value.trim(); }));
        on('prop-checked', 'change', commit(function (f, n) { f.value = n.checked ? 'true' : ''; }));
        on('prop-required', 'change', commit(function (f, n) { f.required = n.checked; }));
        on('prop-readonly', 'change', commit(function (f, n) { f.readonly = n.checked; }));

        on('prop-fontSize', 'change', commit(function (f, n) { f.fontSize = clamp(parseFloat(n.value) || 12, 6, 96); }));
        on('prop-borderWidth', 'change', commit(function (f, n) { f.borderWidth = clamp(parseFloat(n.value) || 0, 0, 8); }));
        on('prop-textColor', 'change', commit(function (f, n) { f.textColor = n.value; }));
        on('prop-borderColor', 'change', commit(function (f, n) { f.borderColor = n.value; }));
        on('prop-fill', 'change', commit(function (f, n) { f.fillColor = n.value; }));
        on('prop-align', 'change', commit(function (f, n) { f.align = n.value; }));

        on('project-name', 'change', function () {
            state.name = ($('project-name').value || 'Untitled').trim() || 'Untitled';
            triggerAutoSave();
        });
        on('doc-prefix', 'change', function () {
            state.prefix = ($('doc-prefix').value || 'field').trim() || 'field';
            triggerAutoSave();
        });
        on('export-flatten', 'change', function () {
            state.flatten = $('export-flatten').checked;
            triggerAutoSave();
        });
        on('btn-clear-fields', 'click', function () {
            if (!state.fields.length) return;
            if (!confirm('Remove all ' + state.fields.length + ' fields?')) return;
            pushUndo();
            state.fields = [];
            state.selectedId = null;
            renderFields();
            triggerAutoSave();
        });
    }

    // ─────────────────────────────────────────────────────────────
    // Fields (layers) list
    // ─────────────────────────────────────────────────────────────
    function updateLayerList() {
        if (!layerList) return;
        layerList.innerHTML = '';
        var count = $('layers-count');
        if (count) count.textContent = state.fields.length + (state.fields.length === 1 ? ' field' : ' fields');

        if (!state.fields.length) {
            var empty = el('div', 'layer-empty', layerList);
            empty.textContent = 'No fields yet. Pick a field tool and click on the page.';
            return;
        }

        state.fields.slice().sort(function (a, b) {
            if (a.page !== b.page) return a.page - b.page;
            return (b.y - a.y) || (a.x - b.x);
        }).forEach(function (f) {
            var item = el('div', 'layer-item', layerList);
            item.dataset.id = f.id;
            if (f.id === state.selectedId) item.classList.add('active');

            var icon = el('span', 'layer-icon', item);
            icon.innerHTML = fieldIconSVG(f.type);

            var name = el('span', 'layer-name', item);
            name.textContent = f.name || FIELD_TYPES[f.type].label;

            var type = el('span', 'layer-type', item);
            type.textContent = FIELD_TYPES[f.type].label.split(' ')[0];

            var del = el('button', 'layer-del', item);
            del.innerHTML = '&times;';
            del.title = 'Delete field';
            del.addEventListener('click', function (e) {
                e.stopPropagation();
                selectField(f.id);
                deleteSelected();
            });

            item.addEventListener('click', function () {
                selectField(f.id);
                scrollFieldIntoView(f);
            });
        });
    }

    function fieldIconSVG(type) {
        var common = 'width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"';
        switch (type) {
            case 'checkbox': return '<svg ' + common + '><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="8 12 11 15 16 9"/></svg>';
            case 'radio': return '<svg ' + common + '><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"/></svg>';
            case 'dropdown': return '<svg ' + common + '><rect x="3" y="6" width="18" height="12" rx="2"/><polyline points="15 10 17 12 15 14"/></svg>';
            case 'date': return '<svg ' + common + '><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
            case 'signature': return '<svg ' + common + '><path d="M3 18c3 0 4-8 7-8s2 6 5 6 3-3 6-3"/><line x1="3" y1="21" x2="21" y2="21"/></svg>';
            case 'textarea': return '<svg ' + common + '><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="7" y1="9" x2="17" y2="9"/><line x1="7" y1="13" x2="17" y2="13"/></svg>';
            default: return '<svg ' + common + '><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>';
        }
    }

    function scrollFieldIntoView(f) {
        var rec = pageView(f.page);
        if (rec && rec.wrap.scrollIntoView) {
            rec.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Tool selection
    // ─────────────────────────────────────────────────────────────
    function setTool(tool) {
        state.tool = tool;
        canvasContainer.classList.toggle('placing', tool !== 'select');
        document.querySelectorAll('[data-tool]').forEach(function (b) {
            b.classList.toggle('active', b.dataset.tool === tool);
        });
    }

    window.onToolChange = function (tool) {
        setTool(tool);
    };

    // ─────────────────────────────────────────────────────────────
    // Zoom
    // ─────────────────────────────────────────────────────────────
    function setScale(newScale) {
        newScale = clamp(newScale, 0.2, 4);
        if (newScale === scale) return;
        scale = newScale;
        busy(true, 'Re-rendering…');
        renderPages().then(function () {
            busy(false);
            syncSelectionSections();
            syncFieldPanel();
            updateZoomUI();
        }).catch(function () {
            busy(false);
        });
    }

    function updateZoomUI() {
        var z = $('zoom-level');
        if (z) z.textContent = Math.round(scale * 100) + '%';
    }

    function fitWidth() {
        if (!pageViews.length) return;
        var rec = pageViews[0];
        var avail = canvasContainer.clientWidth - 64;
        if (rec.wrap.offsetWidth > 0) {
            setScale(avail / (rec.wrap.offsetWidth / scale));
        }
    }

    // ─────────────────────────────────────────────────────────────
    // Export — build a real AcroForm with pdf-lib
    // ─────────────────────────────────────────────────────────────
    function buildFieldDataForExport(doc, form) {
        // Collect names already present so we never clash.
        var used = {};
        try {
            form.getFields().forEach(function (fl) { used[fl.getName()] = true; });
        } catch (e) {}

        function claimName(raw, fallback) {
            var base = sanitizeName(raw, fallback || 'field');
            var name = base, i = 2;
            while (used[name]) { name = base + '_' + i; i++; }
            used[name] = true;
            return name;
        }

        var pageCount = doc.getPageCount();
        var radioGroups = {};
        var radioNameMap = {};

        state.fields.forEach(function (f) {
            if (f.page < 1 || f.page > pageCount) return;
            var page = doc.getPage(f.page - 1);
            var baseOpts = {
                x: f.x,
                y: f.y,
                width: Math.max(4, f.w),
                height: Math.max(4, f.h),
                borderWidth: f.borderWidth,
                borderColor: hexToRgb(f.borderColor),
                backgroundColor: hexToRgb(f.fillColor)
            };

            if (f.type === 'radio') {
                var rawGroup = f.group || f.name || 'group';
                var groupName = radioNameMap[rawGroup] || (radioNameMap[rawGroup] = claimName(rawGroup, 'group'));
                var rg = radioGroups[groupName];
                if (!rg) {
                    rg = radioGroups[groupName] = { field: form.createRadioGroup(groupName), values: {} };
                }
                var val = sanitizeName(f.radioValue || f.name, 'option');
                if (rg.values[val]) { // duplicate option in same group: skip widget
                    return;
                }
                rg.values[val] = true;
                rg.field.addOptionToPage(val, page, baseOpts);
                if (isTruthy(f.value)) rg.field.select(val);
                if (f.required) rg.field.enableRequired();
                if (f.readonly) rg.field.enableReadOnly();
                return;
            }

            var name = claimName(f.name, f.type + '_' + (state.fields.indexOf(f) + 1));

            if (f.type === 'checkbox') {
                var cb = form.createCheckBox(name);
                cb.addToPage(page, baseOpts);
                if (isTruthy(f.value)) cb.check();
                if (f.required) cb.enableRequired();
                if (f.readonly) cb.enableReadOnly();
                return;
            }

            if (f.type === 'dropdown') {
                var dd = form.createDropdown(name);
                var opts = (f.options && f.options.length ? f.options : [f.value || '']);
                dd.setOptions(opts.map(String));
                dd.addToPage(page, baseOpts);
                if (f.value && opts.indexOf(f.value) !== -1) dd.select(String(f.value));
                if (f.fontSize) dd.setFontSize(f.fontSize);
                if (f.required) dd.enableRequired();
                if (f.readonly) dd.enableReadOnly();
                return;
            }

            // text / textarea / date / signature -> text field
            var tf = form.createTextField(name);
            if (f.value) tf.setText(String(f.value));
            tf.addToPage(page, baseOpts);
            if (f.type === 'textarea') tf.enableMultiline();
            if (f.fontSize) tf.setFontSize(f.fontSize);
            tf.setAlignment(ALIGN_MAP[f.align] != null ? ALIGN_MAP[f.align] : 0);
            if (f.required) tf.enableRequired();
            if (f.readonly) tf.enableReadOnly();
        });
    }

    function exportPdf() {
        if (!pdfBytes) { toast('Open or create a PDF first', 'error'); return; }
        busy(true, 'Building fillable PDF…');
        PDFLib.PDFDocument.load(pdfBytes.slice(0)).then(function (doc) {
            var form = doc.getForm();
            buildFieldDataForExport(doc, form);
            try { form.updateFieldAppearances(); } catch (e) { console.warn('appearance update', e); }
            if (state.flatten) {
                try { form.flatten(); } catch (e) { console.warn('flatten', e); }
            }
            return doc.save();
        }).then(function (out) {
            var filename = sanitizeName(state.name || 'fillable', 'fillable') + (state.flatten ? '_flat' : '_fillable') + '.pdf';
            downloadBytes(out, filename, 'application/pdf');
            busy(false);
            toast('Exported ' + filename, 'success');
            logAction('Exported ' + filename, 'sys');
        }).catch(function (err) {
            busy(false);
            console.error(err);
            toast('Export failed: ' + (err && err.message ? err.message : err), 'error');
        });
    }

    function downloadBytes(bytes, filename, mime) {
        var blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            URL.revokeObjectURL(url);
            a.remove();
        }, 1500);
    }

    // ─────────────────────────────────────────────────────────────
    // Project save / load (JSON)
    // ─────────────────────────────────────────────────────────────
    window.getAppState = function () {
        return {
            app: 'fillablepdf',
            version: APP_VERSION,
            name: state.name,
            prefix: state.prefix,
            flatten: state.flatten,
            fields: state.fields,
            pdf: pdfBytes ? bytesToBase64(pdfBytes) : null
        };
    };

    window.applyAutoSavePayload = function (payload) {
        if (!payload || payload.app !== 'fillablepdf') return;
        state.name = payload.name || 'Untitled';
        state.prefix = payload.prefix || 'field';
        state.flatten = !!payload.flatten;
        state.fields = Array.isArray(payload.fields) ? payload.fields : [];
        state.selectedId = null;
        idCounter = state.fields.length + 1;
        undoStack = []; redoStack = [];
        syncDocumentPanel();
        if (payload.pdf) {
            loadPdfBytes(base64ToBytes(payload.pdf), state.name, { keepFields: true, silent: true });
        } else {
            renderFields();
            syncFieldPanel();
        }
    };

    function saveProjectFile() {
        // Fallback path (browsers without File System Access): download JSON.
        var payload = window.getAppState();
        var text = JSON.stringify(payload);
        var blob = new Blob([text], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = sanitizeName(state.name || 'project', 'project') + '.fillablepdf.json';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
    }

    window.onSave = function () { saveProjectFile(); };

    window.onLoad = function () { $('file-project').click(); };

    window.onNew = function () {
        if (state.fields.length && !confirm('Start a new document? Unsaved fields will be lost.')) return;
        destroyDocument();
        pdfBytes = null;
        state.fields = [];
        state.selectedId = null;
        state.name = 'Untitled';
        idCounter = 1;
        undoStack = []; redoStack = [];
        renderFields();
        syncDocumentPanel();
        syncFieldPanel();
        updateUndoButtons();
        if (startOverlay) startOverlay.classList.remove('hidden');
    };

    function loadProjectFile(file) {
        var reader = new FileReader();
        reader.onload = function () {
            busy(true, 'Loading project…');
            try {
                var payload = JSON.parse(reader.result);
                if (!payload || payload.app !== 'fillablepdf') {
                    throw new Error('Not a FillablePDF project file');
                }
                state.name = payload.name || 'Untitled';
                state.prefix = payload.prefix || 'field';
                state.flatten = !!payload.flatten;
                state.fields = Array.isArray(payload.fields) ? payload.fields : [];
                state.selectedId = null;
                idCounter = state.fields.length + 1;
                undoStack = []; redoStack = [];
                syncDocumentPanel();
                if (payload.pdf) {
                    loadPdfBytes(base64ToBytes(payload.pdf), state.name, { keepFields: true, silent: true }).then(function () {
                        renderFields();
                        syncFieldPanel();
                        updateUndoButtons();
                    });
                } else {
                    renderFields();
                    syncFieldPanel();
                    busy(false);
                }
            } catch (err) {
                busy(false);
                console.error(err);
                toast('Could not load project: ' + err.message, 'error');
            }
        };
        reader.readAsText(file);
    }

    // ─────────────────────────────────────────────────────────────
    // File inputs & drag/drop
    // ─────────────────────────────────────────────────────────────
    function wireFileIO() {
        var pdfInput = $('file-pdf');
        var projInput = $('file-project');

        function choosePdf() { pdfInput.value = ''; pdfInput.click(); }

        var openBtn = $('btn-open-pdf');
        if (openBtn) openBtn.addEventListener('click', choosePdf);
        var startOpen = $('start-open-pdf');
        if (startOpen) startOpen.addEventListener('click', choosePdf);

        if (pdfInput) pdfInput.addEventListener('change', function () {
            if (!this.files || !this.files[0]) return;
            readPdfFile(this.files[0]);
        });

        if (projInput) projInput.addEventListener('change', function () {
            if (!this.files || !this.files[0]) return;
            loadProjectFile(this.files[0]);
        });

        var startBlank = $('start-blank');
        if (startBlank) startBlank.addEventListener('click', function () { newBlankDocument('letter'); });

        document.querySelectorAll('.size-chip').forEach(function (chip) {
            chip.addEventListener('click', function () { newBlankDocument(chip.dataset.size); });
        });

        var exportBtn = $('btn-export-pdf');
        if (exportBtn) exportBtn.addEventListener('click', exportPdf);

        // Drag & drop anywhere over the workspace / start overlay
        ['dragenter', 'dragover'].forEach(function (ev) {
            document.addEventListener(ev, function (e) {
                if (!hasFiles(e)) return;
                e.preventDefault();
                if (startOverlay && !startOverlay.classList.contains('hidden')) {
                    startOverlay.classList.add('drag-over');
                }
            });
        });
        document.addEventListener('dragleave', function (e) {
            if (startOverlay) startOverlay.classList.remove('drag-over');
        });
        document.addEventListener('drop', function (e) {
            if (!hasFiles(e)) return;
            e.preventDefault();
            if (startOverlay) startOverlay.classList.remove('drag-over');
            var file = e.dataTransfer.files[0];
            if (/\.json$|\.fillablepdf$/i.test(file.name)) loadProjectFile(file);
            else readPdfFile(file);
        });
    }

    function hasFiles(e) {
        return e.dataTransfer && e.dataTransfer.types &&
            Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') !== -1;
    }

    function readPdfFile(file) {
        var reader = new FileReader();
        reader.onload = function () {
            loadPdfBytes(new Uint8Array(reader.result), file.name.replace(/\.pdf$/i, ''), {});
        };
        reader.readAsArrayBuffer(file);
    }

    // ─────────────────────────────────────────────────────────────
    // Context menu / duplicate / delete / undo / redo
    // ─────────────────────────────────────────────────────────────
    window.onDuplicate = function () {
        if (window._readOnly) return;
        duplicateSelected();
    };
    window.onDelete = function () {
        if (window._readOnly) return;
        deleteSelected();
    };
    window.onUndo = function () { if (!window._readOnly) undo(); };
    window.onRedo = function () { if (!window._readOnly) redo(); };

    window.onContextMenu = function (action) {
        var f = getSelected();
        if (!f) return;
        if (action === 'duplicate') duplicateSelected();
        else if (action === 'delete') deleteSelected();
        else if (action === 'bring-forward') { reorderField(f, 1); }
        else if (action === 'send-backward') { reorderField(f, -1); }
    };

    // Show context menu on right-click over a field
    document.addEventListener('contextmenu', function (e) {
        var node = e.target.closest('.field');
        var menu = $('context-menu');
        if (!node || !menu) return;
        e.preventDefault();
        selectField(node.dataset.id);
        menu.classList.remove('hidden');
        var x = Math.min(e.clientX, window.innerWidth - 180);
        var y = Math.min(e.clientY, window.innerHeight - 200);
        menu.style.left = x + 'px';
        menu.style.top = y + 'px';
    });

    // ─────────────────────────────────────────────────────────────
    // Keyboard
    // ─────────────────────────────────────────────────────────────
    function isTypingTarget(t) {
        if (!t) return false;
        var tag = t.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    }

    document.addEventListener('keydown', function (e) {
        if (isTypingTarget(e.target)) {
            if (e.key === 'Escape') e.target.blur();
            return;
        }
        var mod = e.ctrlKey || e.metaKey;

        if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
        if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
        if (mod && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); duplicateSelected(); return; }
        if (mod && (e.key === 'e' || e.key === 'E')) { e.preventDefault(); exportPdf(); return; }
        if (mod && (e.key === 's' || e.key === 'S')) {
            // Let ui.js autosave flow handle it: trigger the save button.
            var saveBtn = $('btn-save');
            if (saveBtn) { e.preventDefault(); saveBtn.click(); }
            return;
        }
        if (mod && (e.key === 'o' || e.key === 'O')) {
            e.preventDefault();
            var loadBtn = $('btn-load');
            if (loadBtn) loadBtn.click();
            return;
        }
        if (mod) return;

        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
        if (e.key === 'Escape') { setTool('select'); selectField(null); return; }

        var toolKeys = { v: 'select', t: 'text', c: 'checkbox', r: 'radio', d: 'dropdown', s: 'signature', m: 'textarea' };
        if (toolKeys[e.key.toLowerCase()]) {
            setTool(toolKeys[e.key.toLowerCase()]);
            var btn = document.querySelector('[data-tool="' + toolKeys[e.key.toLowerCase()] + '"]');
            if (btn) {
                document.querySelectorAll('.tool-btn').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
            }
            return;
        }

        // Nudge selected field with arrows
        var f = getSelected();
        if (f && e.key.indexOf('Arrow') === 0) {
            e.preventDefault();
            var step = e.shiftKey ? 10 : 1;
            pushUndo();
            if (e.key === 'ArrowLeft') f.x -= step;
            if (e.key === 'ArrowRight') f.x += step;
            if (e.key === 'ArrowUp') f.y += step;
            if (e.key === 'ArrowDown') f.y -= step;
            renderFields();
            syncGeometryInputs(f);
            triggerAutoSave();
        }
    });

    // ─────────────────────────────────────────────────────────────
    // Read-only handling
    // ─────────────────────────────────────────────────────────────
    window.onReadOnlyChange = function (readOnly) {
        canvasContainer.classList.toggle('read-only', !!readOnly);
    };

    // ─────────────────────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────────────────────
    function init() {
        if (!PDFLib) { toast('pdf-lib failed to load', 'error'); return; }
        if (!pdfjsLib) { toast('pdf.js failed to load', 'error'); return; }
        if (startOverlay) startOverlay.classList.remove('hidden');

        bindPanelInputs();
        wireFileIO();

        pagesLayer.addEventListener('pointerdown', onPointerDown);
        canvasContainer.addEventListener('contextmenu', function (e) {
            if (!e.target.closest('.field')) return;
            // handled by document-level listener
        });

        $('zoom-in') && $('zoom-in').addEventListener('click', function () { setScale(scale * 1.2); });
        $('zoom-out') && $('zoom-out').addEventListener('click', function () { setScale(scale / 1.2); });
        $('zoom-fit') && $('zoom-fit').addEventListener('click', fitWidth);

        updateUndoButtons();
        syncDocumentPanel();
        syncSelectionSections();
        updateZoomUI();

        // Prevent the browser context menu in the workspace when not on a field
        canvasContainer.addEventListener('contextmenu', function (e) {
            if (!e.target.closest('.field')) e.preventDefault();
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();