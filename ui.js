// ===== freeopentools_template — UI Interaction Layer =====
// This file provides the baseline UI interactions shared across all Free Open Tools apps.
// Each app-specific app.js loads AFTER this file and handles its own domain logic.
//
// Template placeholders (replace with app-specific values):
//   fillablepdf       — e.g. "diagram", "layout", "flowchart"
//   [APP_NAME]     — e.g. "Diagram", "Layout", "Flowchart"
//   [APP_TAGLINE]  — e.g. "Canvas Editor", "Floor Plan Designer"
//
// ── Theme toggle ──────────────────────────────────────────────────────────────
(function() {
    'use strict';

    // === Theme ===
    var THEME_KEY = 'fillablepdf-theme';
    var themeToggle = document.getElementById('theme-toggle');
    if (themeToggle) {
        themeToggle.addEventListener('click', function() {
            var html = document.documentElement;
            var isDark = html.dataset.theme !== 'light';
            html.dataset.theme = isDark ? 'light' : 'dark';
            var sun = this.querySelector('.theme-sun');
            var moon = this.querySelector('.theme-moon');
            if (sun) sun.style.display = isDark ? 'block' : 'none';
            if (moon) moon.style.display = isDark ? 'none' : 'block';
            localStorage.setItem(THEME_KEY, isDark ? 'light' : 'dark');
        });
    }

    // ── BroadcastChannel: Multi-Tab Coordination ──
    window._readOnly = false;
    window._tabId = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    window._channel = null;

    function setupBroadcastChannel() {
        try {
            window._channel = new BroadcastChannel('fillablepdf-sync');
        } catch(e) {
            return;  // BroadcastChannel not supported
        }

        var claimTimeout = null;

        window._channel.onmessage = function(ev) {
            var msg = ev.data;
            if (!msg || !msg.type) return;

            switch (msg.type) {
                case 'claim':
                    if (msg.tabId === window._tabId) break;
                    if (!window._readOnly) {
                        window._channel.postMessage({ type: 'deny', ownerTabId: window._tabId, tabId: msg.tabId });
                    } else if (claimTimeout) {
                        if (msg.tabId < window._tabId) {
                            clearTimeout(claimTimeout);
                            claimTimeout = null;
                        }
                    }
                    break;
                case 'deny':
                    if (msg.tabId === window._tabId) {
                        clearTimeout(claimTimeout);
                        claimTimeout = null;
                        setReadOnly(true, msg.ownerTabId || 'another tab');
                    }
                    break;
                case 'release':
                    if (window._readOnly && msg.tabId !== window._tabId) {
                        tryBecomeEditor();
                    }
                    break;
                case 'state-changed':
                    if (window._readOnly && msg.tabId !== window._tabId) {
                        if (typeof window.applyAutoSavePayload === 'function') {
                            var raw = localStorage.getItem('fillablepdf-state');
                            if (raw) {
                                try { window.applyAutoSavePayload(JSON.parse(raw)); } catch(e) {}
                            }
                        }
                    }
                    break;
            }
        };

        function tryBecomeEditor() {
            window._channel.postMessage({ type: 'claim', tabId: window._tabId });
            clearTimeout(claimTimeout);
            claimTimeout = setTimeout(function() {
                setReadOnly(false);
            }, 250);
        }

        tryBecomeEditor();
    }

    function setReadOnly(readOnly, ownerHint) {
        var wasReadOnly = window._readOnly;
        window._readOnly = readOnly;
        if (readOnly) {
            document.body.classList.add('read-only-mode');
            var banner = document.getElementById('readonly-banner');
            if (banner) {
                banner.textContent = 'Read-only — ' + (ownerHint || 'another tab') + ' is editing';
                banner.style.display = '';
            }
        } else {
            document.body.classList.remove('read-only-mode');
            var banner2 = document.getElementById('readonly-banner');
            if (banner2) banner2.style.display = 'none';
        }
        if (typeof window.onReadOnlyChange === 'function') {
            window.onReadOnlyChange(readOnly);
        }
    }

    function releaseChannel() {
        if (window._channel && !window._readOnly) {
            try {
                window._channel.postMessage({ type: 'release', tabId: window._tabId });
                window._channel.close();
            } catch(e) {}
        }
    }

    // Listen for localStorage changes from other tabs
    window.addEventListener('storage', function(e) {
        if (e.key === 'fillablepdf-state' && window._readOnly && e.newValue) {
            if (typeof window.applyAutoSavePayload === 'function') {
                try { window.applyAutoSavePayload(JSON.parse(e.newValue)); } catch(ex) {}
            }
        }
    });

    window.addEventListener('beforeunload', releaseChannel);
    window.addEventListener('pagehide', releaseChannel);

    // === Panel collapse ===
    var propsPanel = document.getElementById('properties-panel');
    var btnCollapse = document.getElementById('btn-collapse-panel');
    var panelHeader = document.getElementById('panel-header');
    var PANEL_COLLAPSED_KEY = 'fillablepdf-panel-collapsed';
    var PANEL_WIDTH_KEY = 'fillablepdf-panel-width';

    function togglePanel() {
        var collapsed = propsPanel.classList.toggle('collapsed');
        var svg = btnCollapse.querySelector('svg');
        if (collapsed) {
            btnCollapse.title = 'Expand panel (Ctrl+\\)';
            if (svg) svg.style.transform = 'scaleX(-1)';
            propsPanel.style.width = '';
        } else {
            btnCollapse.title = 'Collapse panel (Ctrl+\\)';
            if (svg) svg.style.transform = '';
            var savedW = localStorage.getItem(PANEL_WIDTH_KEY);
            if (savedW) {
                var w = parseInt(savedW, 10);
                if (w >= 120 && w <= 600) propsPanel.style.width = w + 'px';
            }
        }
        localStorage.setItem(PANEL_COLLAPSED_KEY, collapsed ? '1' : '0');
        if (typeof window.onPanelCollapse === 'function') window.onPanelCollapse(collapsed);
    }
    if (btnCollapse) {
        btnCollapse.addEventListener('click', function(e) {
            e.stopPropagation();
            togglePanel();
        });
    }
    if (panelHeader) {
        panelHeader.addEventListener('click', function(e) {
            if (propsPanel.classList.contains('collapsed') && e.target !== btnCollapse) {
                togglePanel();
            }
        });
    }

    // === Panel resize handle ===
    var panelResizeHandle = document.getElementById('panel-resize-handle');
    if (panelResizeHandle) {
        panelResizeHandle.addEventListener('pointerdown', function(e) {
            e.preventDefault();
            panelResizeHandle.setPointerCapture(e.pointerId);
            panelResizeHandle.classList.add('active');
            panelResizeHandle._startW = propsPanel.offsetWidth;
            panelResizeHandle._startX = e.clientX;
        });
        document.addEventListener('pointermove', function(e) {
            if (!panelResizeHandle.classList.contains('active')) return;
            var dx = panelResizeHandle._startX - e.clientX;
            var newW = Math.max(120, Math.min(600, panelResizeHandle._startW + dx));
            propsPanel.style.width = newW + 'px';
        });
        document.addEventListener('pointerup', function(e) {
            if (!panelResizeHandle.classList.contains('active')) return;
            panelResizeHandle.classList.remove('active');
            try { localStorage.setItem(PANEL_WIDTH_KEY, String(propsPanel.offsetWidth)); } catch (e) {}
            if (typeof window.onPanelResize === 'function') window.onPanelResize(propsPanel.offsetWidth);
        });
    }

    // === Collapsible panel sections ===
    var COLLAPSED_SECTIONS_KEY = 'fillablepdf-collapsed-sections';

    function bindSectionToggles() {
        document.querySelectorAll('.panel-toggle').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var section = this.closest('.panel-section');
                if (section) {
                    section.classList.toggle('collapsed');
                    try {
                        var s = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) || '{}');
                        var id = section.id || Array.from(section.parentNode.children).indexOf(section);
                        s[id] = section.classList.contains('collapsed');
                        localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify(s));
                    } catch (e) {}
                    if (typeof window.onPanelResize === 'function') window.onPanelResize(propsPanel.offsetWidth);
                }
            });
        });
    }

    function restoreSectionStates() {
        try {
            var saved = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) || '{}');
            document.querySelectorAll('.panel-section').forEach(function(sec) {
                var id = sec.id || Array.from(sec.parentNode.children).indexOf(sec);
                if (saved[id]) sec.classList.add('collapsed');
            });
        } catch (e) {}
    }

    // === Log toggle ===
    var logToggle = document.getElementById('log-toggle');
    if (logToggle) {
        logToggle.addEventListener('click', function() {
            var panel = document.querySelector('.panel-log');
            var open = panel.classList.toggle('open');
            var svg = this.querySelector('svg');
            if (svg) svg.style.transform = open ? 'rotate(180deg)' : '';
        });
    }

    // === Action Log helper ===
    var logBody = document.getElementById('log-body');
    var MAX_LOG_ENTRIES = 500;
    function addLogEntry(msg, type) {
        type = type || 'sys';
        var now = new Date();
        var ts = now.getHours().toString().padStart(2, '0') + ':' +
                 now.getMinutes().toString().padStart(2, '0') + ':' +
                 now.getSeconds().toString().padStart(2, '0');
        var el = document.createElement('div');
        el.className = 'log-entry';
        el.innerHTML = '<span class="log-time">' + ts + '</span><span class="log-' + type + '">' + msg + '</span>';
        if (logBody) {
            logBody.appendChild(el);
            if (logBody.children.length > MAX_LOG_ENTRIES) {
                logBody.removeChild(logBody.firstChild);
            }
            logBody.scrollTop = logBody.scrollHeight;
        }
        if (typeof window.onActionLog === 'function') window.onActionLog(msg, type);
    }

    // === Tab switching (Properties / Layers) ===
    document.addEventListener('click', function(e) {
        var tab = e.target.closest('.panel-tab');
        if (!tab) return;
        var target = tab.dataset.tab;
        document.querySelectorAll('.panel-tab').forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        var scroll = document.querySelector('.panel-scroll');
        var layers = document.getElementById('panel-layers');
        if (scroll) scroll.style.display = target === 'properties' ? '' : 'none';
        if (layers) layers.style.display = target === 'layers' ? '' : 'none';
        if (typeof window.onTabChange === 'function') window.onTabChange(target);
    });



    // === Context menu ===
    var contextMenu = document.getElementById('context-menu');
    if (contextMenu) {
        document.addEventListener('click', function(e) {
            if (!contextMenu.contains(e.target)) contextMenu.classList.add('hidden');
        });
        contextMenu.addEventListener('click', function(e) {
            var item = e.target.closest('.context-item');
            if (!item) return;
            if (window._readOnly) return;  // read-only: no context menu actions
            var action = item.dataset.action;
            if (typeof window.onContextMenu === 'function') window.onContextMenu(action, e);
            contextMenu.classList.add('hidden');
        });
        // Prevent context menu from opening in read-only mode
        window.addEventListener('contextmenu', function(e) {
            if (window._readOnly) {
                var menu = document.getElementById('context-menu');
                if (menu && !menu.classList.contains('hidden')) {
                    menu.classList.add('hidden');
                }
            }
        }, true);
    }

    // === Keyboard shortcuts ===
    document.addEventListener('keydown', function(e) {
        // Alt+T: toggle theme
        if (e.altKey && e.key === 't') {
            e.preventDefault();
            if (themeToggle) themeToggle.click();
        }
        // Ctrl+\: toggle panel
        if ((e.ctrlKey || e.metaKey) && e.key === '\\') {
            e.preventDefault();
            if (btnCollapse) btnCollapse.click();
        }
        // Ctrl+/: toggle grid (app-specific)
        if ((e.ctrlKey || e.metaKey) && e.key === '/') {
            // Let app handle this
        }
    });



    // === New / Save / Load ===
    var btnSave = document.getElementById('btn-save');
    var btnLoad = document.getElementById('btn-load');
    var btnNew = document.getElementById('btn-new');

    // ── File System Access API: Auto-Save ──
    var AUTO_SAVE_DB = 'fillablepdf-fs-handles';
    var AUTO_SAVE_STORE = 'handles';
    var AUTO_SAVE_KEY = 'current-handle';
    var autoSaveFileHandle = null;

    function fsApiSupported() {
        return typeof window.showSaveFilePicker === 'function';
    }

    function openAutoSaveDB() {
        return new Promise(function(resolve, reject) {
            var req = indexedDB.open(AUTO_SAVE_DB, 1);
            req.onupgradeneeded = function() { req.result.createObjectStore(AUTO_SAVE_STORE); };
            req.onsuccess = function() { resolve(req.result); };
            req.onerror = function() { reject(req.error); };
        });
    }

    function storeFileHandle(handle) {
        return openAutoSaveDB().then(function(db) {
            return new Promise(function(resolve, reject) {
                var tx = db.transaction(AUTO_SAVE_STORE, 'readwrite');
                tx.objectStore(AUTO_SAVE_STORE).put(handle, AUTO_SAVE_KEY);
                tx.oncomplete = function() { db.close(); resolve(); };
                tx.onerror = function() { db.close(); reject(tx.error); };
            });
        });
    }

    function loadFileHandle() {
        return openAutoSaveDB().then(function(db) {
            return new Promise(function(resolve) {
                var tx = db.transaction(AUTO_SAVE_STORE, 'readonly');
                var req = tx.objectStore(AUTO_SAVE_STORE).get(AUTO_SAVE_KEY);
                req.onsuccess = function() { db.close(); resolve(req.result || null); };
                req.onerror = function() { db.close(); resolve(null); };
            });
        }).catch(function() { return null; });
    }

    function clearFileHandle() {
        return openAutoSaveDB().then(function(db) {
            return new Promise(function(resolve) {
                var tx = db.transaction(AUTO_SAVE_STORE, 'readwrite');
                tx.objectStore(AUTO_SAVE_STORE).delete(AUTO_SAVE_KEY);
                tx.oncomplete = function() { db.close(); resolve(); };
                tx.onerror = function() { db.close(); resolve(); };
            });
        }).catch(function() {});
    }

    function getAutoSavePayload() {
        if (typeof window.getAppState === 'function') {
            return window.getAppState();
        }
        return null;
    }

    function writeToAutoSaveFile() {
        if (!autoSaveFileHandle) return Promise.resolve();
        return autoSaveFileHandle.queryPermission({ mode: 'readwrite' }).then(function(state) {
            if (state !== 'granted') {
                return autoSaveFileHandle.requestPermission({ mode: 'readwrite' });
            }
            return state;
        }).then(function(state) {
            if (state !== 'granted') {
                autoSaveFileHandle = null;
                updateAutoSaveUI();
                return;
            }
            var payload = getAutoSavePayload();
            if (!payload) return;
            return autoSaveFileHandle.createWritable().then(function(writable) {
                return writable.write(JSON.stringify(payload, null, 2)).then(function() {
                    return writable.close();
                });
            });
        }).catch(function(err) {
            console.error('Auto-save write failed:', err);
            autoSaveFileHandle = null;
            updateAutoSaveUI();
        });
    }

    function updateAutoSaveUI() {
        var dot = document.getElementById('save-dot');
        if (!dot || !btnSave) return;
        if (autoSaveFileHandle) {
            dot.style.display = '';
            btnSave.title = 'Auto-saving to file. Click to download a backup.';
        } else {
            dot.style.display = 'none';
            btnSave.title = fsApiSupported() ? 'Save — opens auto-save (Chrome/Edge)' : 'Save (Ctrl+S)';
        }
    }

    function startAutoSave() {
        if (!fsApiSupported()) return;
        var opts = {
            suggestedName: 'untitled.json',
            types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
        };
        window.showSaveFilePicker(opts).then(function(handle) {
            autoSaveFileHandle = handle;
            storeFileHandle(handle);
            updateAutoSaveUI();
            writeToAutoSaveFile();
        }).catch(function(err) {
            if (err.name !== 'AbortError') {
                console.error('Auto-save picker failed:', err);
            }
        });
    }

    function restoreAutoSaveHandle() {
        if (!fsApiSupported()) return;
        loadFileHandle().then(function(handle) {
            if (!handle) return;
            return handle.queryPermission({ mode: 'readwrite' }).then(function(state) {
                if (state === 'granted') {
                    autoSaveFileHandle = handle;
                    updateAutoSaveUI();
                } else {
                    return handle.requestPermission({ mode: 'readwrite' }).then(function(state2) {
                        if (state2 === 'granted') {
                            autoSaveFileHandle = handle;
                            updateAutoSaveUI();
                        } else {
                            clearFileHandle();
                        }
                    });
                }
            });
        }).catch(function() {
            clearFileHandle();
        });
    }

    // Hook: app.js calls this after every state mutation to trigger auto-save
    window.triggerAutoSave = function() {
        if (autoSaveFileHandle && !window._readOnly) {
            writeToAutoSaveFile();
        }
        if (window._channel && !window._readOnly) {
            try {
                window._channel.postMessage({ type: 'state-changed', tabId: window._tabId });
            } catch(e) {}
        }
    };

    if (btnSave) {
        btnSave.addEventListener('click', function() {
            // If auto-save is active, download a backup
            if (autoSaveFileHandle) {
                if (typeof window.onSave === 'function') window.onSave();
                return;
            }
            // If File System Access API is available, start auto-save
            if (fsApiSupported()) {
                startAutoSave();
            } else {
                // Fallback: classic download
                if (typeof window.onSave === 'function') window.onSave();
            }
        });
    }
    if (btnLoad) {
        btnLoad.addEventListener('click', function() {
            if (typeof window.onLoad === 'function') window.onLoad();
        });
    }
    if (btnNew) {
        btnNew.addEventListener('click', function() {
            if (typeof window.onNew === 'function') window.onNew();
        });
    }

    // === Duplicate / Delete ===
    var btnDuplicate = document.getElementById('btn-duplicate');
    var btnDelete = document.getElementById('btn-delete');
    if (btnDuplicate) {
        btnDuplicate.addEventListener('click', function() {
            if (typeof window.onDuplicate === 'function') window.onDuplicate();
        });
    }
    if (btnDelete) {
        btnDelete.addEventListener('click', function() {
            if (typeof window.onDelete === 'function') window.onDelete();
        });
    }

    // === Undo / Redo ===
    var btnUndo = document.getElementById('btn-undo');
    var btnRedo = document.getElementById('btn-redo');
    if (btnUndo) {
        btnUndo.addEventListener('click', function() {
            if (typeof window.onUndo === 'function') window.onUndo();
        });
    }
    if (btnRedo) {
        btnRedo.addEventListener('click', function() {
            if (typeof window.onRedo === 'function') window.onRedo();
        });
    }

    // === Tool buttons ===
    var clearToolActive = function() {
        document.querySelectorAll('.tool-btn').forEach(function(b) { b.classList.remove('active'); });
        document.querySelectorAll('.shape-btn').forEach(function(b) { b.classList.remove('active'); });
    };

    document.querySelectorAll('[data-tool]').forEach(function(btn) {
        btn.addEventListener('click', function() {
            var tool = btn.dataset.tool;
            if (typeof window.onToolChange === 'function') window.onToolChange(tool);
            clearToolActive();
            btn.classList.add('active');
        });
    });

    // === Shape buttons ===
    var pendingShape = null;
    document.querySelectorAll('.shape-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
            pendingShape = {
                shape: btn.dataset.shape,
                w: parseInt(btn.dataset.width) || 100,
                h: parseInt(btn.dataset.height) || 80
            };
            if (typeof window.onShapeTool === 'function') window.onShapeTool(pendingShape);
            clearToolActive();
            btn.classList.add('active');
        });
    });

    // === Canvas click to place pending shape ===
    var container = document.getElementById('canvas-container');
    if (container) {
        container.addEventListener('click', function(e) {
            if (!pendingShape || typeof window.onCanvasClick === 'function') {
                pendingShape = null;
            }
        });
    }



    // === Properties panel geometry/text inputs ===
    var propInputs = ['prop-x', 'prop-y', 'prop-width', 'prop-height'];
    propInputs.forEach(function(id) {
        var input = document.getElementById(id);
        if (input) {
            input.addEventListener('change', function() {
                var v = parseFloat(this.value);
                var prop = this.id.replace('prop-', '');
                if (typeof window.onPropChange === 'function') window.onPropChange(prop, v);
            });
        }
    });

    var propText = document.getElementById('prop-text');
    if (propText) {
        propText.addEventListener('change', function() {
            if (typeof window.onPropChange === 'function') window.onPropChange('text', this.value);
        });
    }

    var propName = document.getElementById('prop-name');
    if (propName) {
        propName.addEventListener('change', function() {
            if (typeof window.onPropChange === 'function') window.onPropChange('name', this.value.trim());
        });
    }

    // === Sync toolbar colors from selected object ===
    function syncToolbarFromSelection(fill, stroke, sw, opacityVal, textColorVal) {
        var fillColor = document.getElementById('prop-fill');
        var strokeColor = document.getElementById('prop-borderColor');
        var strokeWidth = document.getElementById('prop-borderWidth');
        var opacity = document.getElementById('prop-opacity');
        var textColor = document.getElementById('prop-textColor');
        if (fillColor) fillColor.value = fill || '#ffffff';
        if (strokeColor) strokeColor.value = stroke || '#333333';
        if (strokeWidth) strokeWidth.value = sw != null ? sw : 2;
        if (opacity) opacity.value = (opacityVal != null ? Math.round(opacityVal * 100) : 100);
        if (textColor) textColor.value = textColorVal || '#111113';
    }

    // === Canvas size inputs ===
    var canvasWidth = document.getElementById('canvas-width');
    var canvasHeight = document.getElementById('canvas-height');
    var projectName = document.getElementById('project-name');
    if (canvasWidth) {
        canvasWidth.addEventListener('change', function() {
            if (typeof window.onCanvasSizeChange === 'function') window.onCanvasSizeChange('width', parseInt(this.value));
        });
    }
    if (canvasHeight) {
        canvasHeight.addEventListener('change', function() {
            if (typeof window.onCanvasSizeChange === 'function') window.onCanvasSizeChange('height', parseInt(this.value));
        });
    }
    if (projectName) {
        projectName.addEventListener('change', function() {
            if (typeof window.onProjectNameChange === 'function') window.onProjectNameChange(this.value.trim());
        });
    }

    // === Expose helpers for app.js ===
    window.UI = {
        syncToolbarFromSelection: syncToolbarFromSelection,
        clearToolActive: clearToolActive,
        pendingShape: pendingShape,
        // Check if current tab is read-only
        isReadOnly: function() { return window._readOnly; },
        // Check if auto-save is active
        isAutoSaving: function() { return !!autoSaveFileHandle; },
        // Restore saved panel state
        restorePanelState: function() {
            if (!propsPanel) return;
            var collapsed = localStorage.getItem(PANEL_COLLAPSED_KEY);
            if (collapsed === '1') {
                propsPanel.classList.add('collapsed');
                var svg = btnCollapse.querySelector('svg');
                if (svg) svg.style.transform = 'scaleX(-1)';
            }
            var savedW = localStorage.getItem(PANEL_WIDTH_KEY);
            if (savedW) {
                var w = parseInt(savedW, 10);
                if (w >= 120 && w <= 600) propsPanel.style.width = w + 'px';
            }
        }
    };

    // Restore panel state on load
    if (propsPanel) UI.restorePanelState();

    // Bind collapsible section toggles and restore states
    bindSectionToggles();
    restoreSectionStates();

    // Set up multi-tab coordination
    setupBroadcastChannel();

    // Try to restore File System Access auto-save handle
    restoreAutoSaveHandle();

})();
