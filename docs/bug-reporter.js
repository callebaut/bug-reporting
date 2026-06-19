/*!
 * Bug Reporter — a bookmarklet-loaded widget for logging rich bug reports.
 *
 * Loaded on demand by a bookmarklet. It injects a Shadow-DOM isolated widget
 * that lets you select an element on the page, screenshot it, annotate the
 * screenshot, add a title/description, and copy a complete bug report
 * (screenshot + environment + console/network errors + cookies/storage) to the
 * clipboard for pasting into Jira / Azure DevOps.
 *
 * Distribution model mirrors openfed/AccessibilityCheck: a bookmarklet loads
 * this script from a hosted location (GitHub Pages); the script loads its
 * single dependency (html2canvas) from the same directory.
 */
(function () {
  'use strict';

  // Re-open if already injected.
  if (window.__bugReporter) {
    window.__bugReporter.open();
    return;
  }

  // ---------------------------------------------------------------------------
  // Capture hooks. Installed as early as possible (on widget load). Note: only
  // events that fire *after* the widget is loaded can be captured. The intended
  // workflow is: open the widget, reproduce the bug, then capture.
  // ---------------------------------------------------------------------------
  var MAX_LOG = 300;
  var consoleLog = [];
  var errorLog = [];
  var networkLog = [];

  function pushCapped(arr, item) {
    arr.push(item);
    if (arr.length > MAX_LOG) arr.shift();
  }

  function serializeArg(a) {
    if (a instanceof Error) return (a.stack || (a.name + ': ' + a.message));
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }
    return String(a);
  }

  (function installConsoleHooks() {
    ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
      var original = console[level];
      if (typeof original !== 'function') return;
      console[level] = function () {
        try {
          var args = Array.prototype.slice.call(arguments);
          pushCapped(consoleLog, {
            level: level,
            time: new Date().toISOString(),
            text: args.map(serializeArg).join(' ')
          });
        } catch (e) { /* never break the host console */ }
        return original.apply(console, arguments);
      };
    });
  })();

  window.addEventListener('error', function (e) {
    pushCapped(errorLog, {
      type: 'uncaught-error',
      time: new Date().toISOString(),
      message: e.message,
      source: e.filename ? (e.filename + ':' + e.lineno + ':' + e.colno) : '',
      stack: e.error && e.error.stack ? e.error.stack : ''
    });
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e.reason;
    pushCapped(errorLog, {
      type: 'unhandled-rejection',
      time: new Date().toISOString(),
      message: reason && reason.message ? reason.message : String(reason),
      stack: reason && reason.stack ? reason.stack : ''
    });
  });

  (function installNetworkHooks() {
    if (typeof window.fetch === 'function') {
      var origFetch = window.fetch;
      window.fetch = function () {
        var args = arguments;
        var url = (args[0] && args[0].url) ? args[0].url : String(args[0]);
        var method = (args[1] && args[1].method) || (args[0] && args[0].method) || 'GET';
        var started = performance.now();
        return origFetch.apply(this, args).then(function (res) {
          if (!res.ok) {
            pushCapped(networkLog, {
              time: new Date().toISOString(), kind: 'fetch', method: method,
              url: url, status: res.status, ms: Math.round(performance.now() - started)
            });
          }
          return res;
        }).catch(function (err) {
          pushCapped(networkLog, {
            time: new Date().toISOString(), kind: 'fetch', method: method,
            url: url, status: 'network-error', error: String(err),
            ms: Math.round(performance.now() - started)
          });
          throw err;
        });
      };
    }

    var OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      var open = OrigXHR.prototype.open;
      var send = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (method, url) {
        this.__br = { method: method, url: url };
        return open.apply(this, arguments);
      };
      OrigXHR.prototype.send = function () {
        var xhr = this;
        var started = performance.now();
        xhr.addEventListener('loadend', function () {
          var info = xhr.__br || {};
          if (xhr.status === 0 || xhr.status >= 400) {
            pushCapped(networkLog, {
              time: new Date().toISOString(), kind: 'xhr',
              method: info.method, url: info.url,
              status: xhr.status === 0 ? 'network-error' : xhr.status,
              ms: Math.round(performance.now() - started)
            });
          }
        });
        return send.apply(this, arguments);
      };
    }
  })();

  // ---------------------------------------------------------------------------
  // Determine our base URL so we can load html2canvas from the same directory.
  // ---------------------------------------------------------------------------
  var baseUrl = (function () {
    var src = (document.currentScript && document.currentScript.src) || '';
    if (!src) {
      var scripts = document.getElementsByTagName('script');
      for (var i = scripts.length - 1; i >= 0; i--) {
        if (/bug-reporter\.js/.test(scripts[i].src)) { src = scripts[i].src; break; }
      }
    }
    return src.replace(/[^/]*$/, ''); // strip filename, keep trailing slash
  })();

  function loadHtml2Canvas(cb) {
    if (window.html2canvas) { cb(); return; }
    var s = document.createElement('script');
    s.src = baseUrl + 'vendor/html2canvas.min.js';
    s.onload = function () { cb(); };
    s.onerror = function () { cb(new Error('Failed to load html2canvas from ' + s.src)); };
    document.head.appendChild(s);
  }

  // High-entropy UA data (async, best-effort).
  var uaData = null;
  if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(
      ['platform', 'platformVersion', 'architecture', 'model', 'uaFullVersion', 'fullVersionList']
    ).then(function (d) { uaData = d; }).catch(function () { });
  }

  // ---------------------------------------------------------------------------
  // Configuration. Defaults can be overridden per user by setting
  // window.__bugReporterConfig before this script loads (the bookmarklet does
  // this — see the landing page generator). Read live so re-clicking the
  // bookmarklet with a new config takes effect.
  //
  //   window.__bugReporterConfig = {
  //     severities: ['Blocker','Critical','Major','Minor','Trivial'],
  //     defaultSeverity: 'Major',
  //     environments: [                      // ordered; first regex match wins
  //       { match: 'localhost|127\\.0\\.0\\.1|\\.local', label: 'Local' },
  //       { match: 'staging|uat|stage|stg|acc|test', label: 'Staging' },
  //       { match: '.*', label: 'Production' }
  //     ]
  //   };
  // ---------------------------------------------------------------------------
  var DEFAULT_CONFIG = {
    severities: ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'],
    defaultSeverity: 'Major',
    environments: [
      { match: 'localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\.local(?::|/|$)', label: 'Local' },
      { match: '\\bdev\\b|//dev\\.|\\.dev\\.|-dev\\.|develop', label: 'Development' },
      { match: 'staging|stage|stg|uat|\\bqa\\b|\\bacc\\b|accept|\\btest\\b|sandbox|preprod|preview', label: 'Staging' },
      { match: '.*', label: 'Production' }
    ]
  };

  function getConfig() {
    var u = window.__bugReporterConfig || {};
    return {
      severities: (u.severities && u.severities.length) ? u.severities : DEFAULT_CONFIG.severities,
      defaultSeverity: u.defaultSeverity || DEFAULT_CONFIG.defaultSeverity,
      environments: (u.environments && u.environments.length) ? u.environments : DEFAULT_CONFIG.environments
    };
  }

  function detectEnvironment(cfg) {
    var url = location.href;
    for (var i = 0; i < cfg.environments.length; i++) {
      var rule = cfg.environments[i];
      try {
        if (new RegExp(rule.match, 'i').test(url)) return rule.label;
      } catch (e) { /* skip invalid pattern */ }
    }
    return 'Unknown';
  }

  // ===========================================================================
  // Widget
  // ===========================================================================
  var BugReporter = (function () {
    var rootHost, shadow, state = 'idle';
    var selectedElement = null;
    var baseCanvas = null;       // html2canvas output
    var annoCanvas = null;       // drawing overlay (same pixel size as baseCanvas)
    var annoCtx = null;
    var shapes = [];             // committed annotations (for undo / redraw)
    var current = null;          // in-progress shape
    var drawTool = 'pen';
    var drawColor = '#ff3b30';
    var drawSize = 4;
    var highlightBox = null;     // element-picker highlight

    // -- Styles -------------------------------------------------------------
    var CSS = [
      ':host{all:initial;}',
      '*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}',
      '.fab{position:fixed;right:20px;bottom:20px;width:52px;height:52px;border-radius:50%;background:#1f6feb;color:#fff;border:none;cursor:pointer;font-size:24px;box-shadow:0 4px 16px rgba(0,0,0,.3);z-index:2147483647;display:flex;align-items:center;justify-content:center;transition:transform .1s;}',
      '.fab:hover{transform:scale(1.08);}',
      '.panel{position:fixed;right:20px;bottom:20px;width:380px;max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);background:#fff;color:#1c2128;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,.35);z-index:2147483647;display:flex;flex-direction:column;overflow:hidden;font-size:13px;}',
      '.hd{display:flex;align-items:center;gap:8px;padding:12px 14px;background:#1f6feb;color:#fff;}',
      '.hd b{font-size:14px;flex:1;}',
      '.hd .x{background:transparent;border:none;color:#fff;cursor:pointer;font-size:18px;line-height:1;padding:2px 6px;border-radius:6px;}',
      '.hd .x:hover{background:rgba(255,255,255,.2);}',
      '.bd{padding:14px;overflow:auto;}',
      '.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 12px;border-radius:8px;border:1px solid #d0d7de;background:#f6f8fa;color:#1c2128;cursor:pointer;font-size:13px;font-weight:600;}',
      '.btn:hover{background:#eaeef2;}',
      '.btn.primary{background:#1f883d;border-color:#1f883d;color:#fff;width:100%;padding:11px;font-size:14px;}',
      '.btn.primary:hover{background:#1a7f37;}',
      '.btn.wide{width:100%;}',
      '.btn.sm{padding:6px 9px;font-size:12px;}',
      '.row{display:flex;gap:8px;margin-top:8px;}',
      '.row.wrap{flex-wrap:wrap;}',
      'label.fld{display:block;margin-top:12px;font-weight:600;font-size:12px;color:#57606a;}',
      'input.txt,textarea.txt,select.txt{width:100%;margin-top:4px;padding:8px;border:1px solid #d0d7de;border-radius:8px;font-size:13px;color:#1c2128;background:#fff;}',
      'select.txt{height:36px;cursor:pointer;}',
      'textarea.txt{resize:vertical;min-height:60px;}',
      '.hint{color:#57606a;font-size:12px;margin:8px 0 0;line-height:1.4;}',
      '.preview{position:relative;margin-top:10px;border:1px solid #d0d7de;border-radius:8px;overflow:auto;max-height:240px;background:#f6f8fa;}',
      '.preview canvas{display:block;}',
      '.preview .stack{position:relative;}',
      '.preview .stack canvas{position:absolute;left:0;top:0;}',
      '.preview .stack canvas.base{position:static;}',
      '.toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:10px;}',
      '.tool{width:32px;height:32px;border-radius:7px;border:1px solid #d0d7de;background:#f6f8fa;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;}',
      '.tool.on{background:#1f6feb;border-color:#1f6feb;color:#fff;}',
      '.swatch{width:22px;height:22px;border-radius:50%;border:2px solid #fff;box-shadow:0 0 0 1px #d0d7de;cursor:pointer;}',
      '.swatch.on{box-shadow:0 0 0 2px #1c2128;}',
      '.chk{display:flex;align-items:flex-start;gap:8px;margin-top:12px;font-size:12px;color:#57606a;line-height:1.4;cursor:pointer;}',
      '.chk input{margin-top:2px;}',
      '.status{margin-top:10px;font-size:12px;min-height:16px;font-weight:600;}',
      '.status.ok{color:#1a7f37;}',
      '.status.err{color:#cf222e;}',
      '.divider{height:1px;background:#eaeef2;margin:14px 0;}',
      // element picker
      '.pickhint{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:#1c2128;color:#fff;padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.4);}',
      '.hl{position:fixed;border:2px solid #1f6feb;background:rgba(31,111,235,.15);pointer-events:none;z-index:2147483646;border-radius:2px;}',
      '.busy{display:flex;align-items:center;gap:8px;color:#57606a;padding:8px 0;}',
      '.spin{width:16px;height:16px;border:2px solid #d0d7de;border-top-color:#1f6feb;border-radius:50%;animation:brspin .7s linear infinite;}',
      '@keyframes brspin{to{transform:rotate(360deg);}}'
    ].join('\n');

    // -- DOM helpers --------------------------------------------------------
    function el(tag, attrs, children) {
      var n = document.createElement(tag);
      if (attrs) Object.keys(attrs).forEach(function (k) {
        if (k === 'class') n.className = attrs[k];
        else if (k === 'text') n.textContent = attrs[k];
        else if (k === 'html') n.innerHTML = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
      (children || []).forEach(function (c) { n.appendChild(c); });
      return n;
    }

    function mount() {
      rootHost = document.createElement('div');
      rootHost.id = '__bug_reporter_root';
      rootHost.setAttribute('data-html2canvas-ignore', 'true'); // exclude from screenshots
      shadow = rootHost.attachShadow({ mode: 'open' });
      var style = document.createElement('style');
      style.textContent = CSS;
      shadow.appendChild(style);
      document.documentElement.appendChild(rootHost);
    }

    function clearShadowBody() {
      // remove everything except the <style>
      Array.prototype.slice.call(shadow.childNodes).forEach(function (n) {
        if (n.tagName !== 'STYLE') shadow.removeChild(n);
      });
    }

    // -- Views --------------------------------------------------------------
    function renderFab() {
      clearShadowBody();
      state = 'idle';
      var fab = el('button', { class: 'fab', title: 'Report a bug' });
      fab.textContent = '🐞';
      fab.onclick = renderPanel;
      shadow.appendChild(fab);
    }

    function panelShell(titleText, bodyNode) {
      var close = el('button', { class: 'x', title: 'Close' });
      close.innerHTML = '&times;';
      close.onclick = renderFab;
      var min = el('button', { class: 'x', title: 'Minimize' });
      min.textContent = '–';
      min.onclick = renderFab;
      var hd = el('div', { class: 'hd' }, [
        el('b', { text: titleText }), min, close
      ]);
      var bd = el('div', { class: 'bd' }, [bodyNode]);
      return el('div', { class: 'panel' }, [hd, bd]);
    }

    function renderPanel() {
      clearShadowBody();
      state = 'panel';
      var pick = el('button', { class: 'btn primary' });
      pick.innerHTML = '🎯 Select an element to capture';
      pick.onclick = startPicking;
      var body = el('div', {}, [
        pick,
        el('p', { class: 'hint', html: 'Click the button, then hover over the page and click the element you want to report a bug about. It will be screenshotted so you can annotate it.<br><br>Tip: reproduce the bug <em>after</em> opening this tool so console &amp; network errors are captured.' })
      ]);
      shadow.appendChild(panelShell('Report a bug', body));
    }

    // -- Element picker -----------------------------------------------------
    function startPicking() {
      clearShadowBody();
      state = 'selecting';
      var hint = el('div', { class: 'pickhint', text: 'Click an element to capture · Esc to cancel' });
      highlightBox = el('div', { class: 'hl' });
      highlightBox.style.display = 'none';
      shadow.appendChild(hint);
      shadow.appendChild(highlightBox);

      document.addEventListener('mousemove', onPickMove, true);
      document.addEventListener('click', onPickClick, true);
      document.addEventListener('keydown', onPickKey, true);
    }

    function stopPicking() {
      document.removeEventListener('mousemove', onPickMove, true);
      document.removeEventListener('click', onPickClick, true);
      document.removeEventListener('keydown', onPickKey, true);
    }

    function elementUnder(x, y) {
      // Our root is in light DOM; elementFromPoint may return it. Temporarily
      // ignore by checking ancestry.
      var node = document.elementFromPoint(x, y);
      if (node && (node === rootHost || rootHost.contains(node))) return null;
      return node;
    }

    function onPickMove(e) {
      var node = elementUnder(e.clientX, e.clientY);
      if (!node) { highlightBox.style.display = 'none'; return; }
      var r = node.getBoundingClientRect();
      highlightBox.style.display = 'block';
      highlightBox.style.left = r.left + 'px';
      highlightBox.style.top = r.top + 'px';
      highlightBox.style.width = r.width + 'px';
      highlightBox.style.height = r.height + 'px';
    }

    function onPickClick(e) {
      var node = elementUnder(e.clientX, e.clientY);
      if (!node) return;
      e.preventDefault();
      e.stopPropagation();
      stopPicking();
      selectedElement = node;
      captureElement(node);
    }

    function onPickKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        stopPicking();
        renderPanel();
      }
    }

    // -- Capture ------------------------------------------------------------
    function captureElement(node) {
      clearShadowBody();
      state = 'capturing';
      var busy = el('div', { class: 'busy' }, [
        el('div', { class: 'spin' }),
        el('span', { text: 'Capturing screenshot…' })
      ]);
      shadow.appendChild(panelShell('Report a bug', busy));

      loadHtml2Canvas(function (err) {
        if (err) { renderError('Could not load the screenshot engine: ' + err.message); return; }
        var scale = Math.min(window.devicePixelRatio || 1, 2);
        window.html2canvas(node, {
          useCORS: true,
          allowTaint: false,
          logging: false,
          backgroundColor: null,
          scale: scale,
          ignoreElements: function (e2) { return e2 === rootHost; }
        }).then(function (canvas) {
          baseCanvas = canvas;
          renderAnnotate();
        }).catch(function (e2) {
          renderError('Screenshot failed: ' + (e2 && e2.message ? e2.message : e2) +
            '. The element may contain cross-origin content.');
        });
      });
    }

    function renderError(msg) {
      clearShadowBody();
      var retry = el('button', { class: 'btn wide' });
      retry.textContent = '← Back';
      retry.onclick = renderPanel;
      var body = el('div', {}, [
        el('p', { class: 'status err', text: msg }),
        retry
      ]);
      shadow.appendChild(panelShell('Report a bug', body));
    }

    // -- Annotation view ----------------------------------------------------
    function renderAnnotate() {
      clearShadowBody();
      state = 'annotating';
      shapes = [];
      current = null;

      // drawing overlay matches base resolution
      annoCanvas = document.createElement('canvas');
      annoCanvas.width = baseCanvas.width;
      annoCanvas.height = baseCanvas.height;
      annoCtx = annoCanvas.getContext('2d');
      baseCanvas.className = 'base';

      var stack = el('div', { class: 'stack' }, [baseCanvas, annoCanvas]);
      // fit width to panel
      var maxW = 348;
      var displayW = Math.min(maxW, baseCanvas.width);
      var ratio = displayW / baseCanvas.width;
      [baseCanvas, annoCanvas].forEach(function (c) {
        c.style.width = displayW + 'px';
        c.style.height = (baseCanvas.height * ratio) + 'px';
      });
      var preview = el('div', { class: 'preview' }, [stack]);

      bindDrawing(annoCanvas);

      // toolbar
      var tools = [['pen', '✏️', 'Pen'], ['rect', '▭', 'Rectangle'], ['arrow', '↗', 'Arrow']];
      var toolBtns = tools.map(function (t) {
        var b = el('button', { class: 'tool' + (t[0] === drawTool ? ' on' : ''), title: t[2], 'data-tool': t[0] });
        b.textContent = t[1];
        b.onclick = function () {
          drawTool = t[0];
          shadow.querySelectorAll('.tool').forEach(function (x) { x.classList.toggle('on', x.getAttribute('data-tool') === drawTool); });
        };
        return b;
      });
      var colors = ['#ff3b30', '#ffcc00', '#34c759', '#1f6feb', '#000000', '#ffffff'];
      var swatchBtns = colors.map(function (c) {
        var s = el('span', { class: 'swatch' + (c === drawColor ? ' on' : ''), title: c });
        s.style.background = c;
        s.onclick = function () {
          drawColor = c;
          shadow.querySelectorAll('.swatch').forEach(function (x) { x.classList.toggle('on', x.title === c); });
        };
        return s;
      });
      var undo = el('button', { class: 'tool', title: 'Undo' }); undo.textContent = '⎌';
      undo.onclick = function () { shapes.pop(); redraw(); };
      var clr = el('button', { class: 'btn sm', title: 'Clear annotations' }); clr.textContent = 'Clear';
      clr.onclick = function () { shapes = []; redraw(); };
      var recap = el('button', { class: 'btn sm', title: 'Pick a different element' }); recap.textContent = 'Re-select';
      recap.onclick = startPicking;

      var toolbar = el('div', { class: 'toolbar' }, toolBtns.concat([
        el('span', { html: '<span style="width:1px;height:24px;background:#eaeef2;display:inline-block"></span>' })
      ]).concat(swatchBtns).concat([undo, clr, recap]));

      // fields
      var titleIn = el('input', { class: 'txt', type: 'text', placeholder: 'e.g. Submit button is misaligned on mobile' });
      var descIn = el('textarea', { class: 'txt', placeholder: 'Steps to reproduce, expected vs actual behaviour…' });
      var titleLbl = el('label', { class: 'fld', text: 'Title' });
      var descLbl = el('label', { class: 'fld', text: 'Description' });

      // severity + environment (config-driven; environment auto-detected from URL)
      var cfg = getConfig();
      var detectedEnv = detectEnvironment(cfg);

      function buildSelect(values, selected) {
        var sel = el('select', { class: 'txt' });
        values.forEach(function (v) {
          var o = el('option', { value: v, text: v });
          if (v === selected) o.selected = true;
          sel.appendChild(o);
        });
        return sel;
      }
      var sevSel = buildSelect(cfg.severities, cfg.defaultSeverity);
      var envValues = cfg.environments.map(function (e) { return e.label; })
        .filter(function (v, i, a) { return a.indexOf(v) === i; });
      if (envValues.indexOf(detectedEnv) < 0) envValues.unshift(detectedEnv);
      var envSel = buildSelect(envValues, detectedEnv);

      var sevCol = el('div', {}, [el('label', { class: 'fld', text: 'Severity' }), sevSel]);
      var envCol = el('div', {}, [el('label', { class: 'fld', html: 'Environment <span style="font-weight:400;color:#57606a">(from URL)</span>' }), envSel]);
      sevCol.style.flex = '1'; envCol.style.flex = '1';
      var metaRow = el('div', { class: 'row' }, [sevCol, envCol]);

      function reportOpts(statusNode) {
        return {
          title: titleIn.value, description: descIn.value,
          severity: sevSel.value, environment: envSel.value,
          includeSensitive: sensChk.checked, status: statusNode
        };
      }

      // sensitive-data toggle
      var sensChk = el('input', { type: 'checkbox' });
      sensChk.checked = true;
      var sensLbl = el('label', { class: 'chk' }, [sensChk,
        el('span', { html: 'Include <b>cookies &amp; storage</b> in the report. May contain auth tokens — leave off for shared tickets.' })]);

      // actions
      var status = el('div', { class: 'status' });
      var copyBtn = el('button', { class: 'btn primary' });
      copyBtn.innerHTML = '📋 Copy bug report to clipboard';
      copyBtn.onclick = function () { copyReport(reportOpts(status)); };
      var dlPng = el('button', { class: 'btn sm' }); dlPng.textContent = '⬇ PNG';
      dlPng.onclick = function () {
        var d = compositeDataUrl();
        if (d) downloadDataUrl(d, 'bug-screenshot.png');
        else setStatus(status, 'Screenshot can\'t be exported (cross-origin content tainted the canvas).', 'err');
      };
      var dlMd = el('button', { class: 'btn sm' }); dlMd.textContent = '⬇ Markdown';
      dlMd.onclick = function () {
        var ctx = collectContext(reportOpts());
        downloadText(buildMarkdown(ctx, false), 'bug-report.md');
      };

      var body = el('div', {}, [
        preview,
        toolbar,
        titleLbl, titleIn,
        descLbl, descIn,
        metaRow,
        sensLbl,
        el('div', { class: 'divider' }),
        copyBtn,
        el('div', { class: 'row' }, [dlPng, dlMd]),
        status
      ]);
      shadow.appendChild(panelShell('Report a bug', body));
      setTimeout(function () { titleIn.focus(); }, 50);
    }

    // -- Drawing ------------------------------------------------------------
    function canvasPoint(canvas, e) {
      var r = canvas.getBoundingClientRect();
      var p = (e.touches && e.touches[0]) || e;
      return {
        x: (p.clientX - r.left) / r.width * canvas.width,
        y: (p.clientY - r.top) / r.height * canvas.height
      };
    }

    function bindDrawing(canvas) {
      function down(e) {
        e.preventDefault();
        var p = canvasPoint(canvas, e);
        current = { tool: drawTool, color: drawColor, size: drawSize * (canvas.width > 1000 ? 2 : 1) };
        if (drawTool === 'pen') current.points = [p];
        else { current.x0 = p.x; current.y0 = p.y; current.x1 = p.x; current.y1 = p.y; }
        redraw();
      }
      function move(e) {
        if (!current || canvas !== annoCanvas) return; // ignore stale bindings after re-capture
        e.preventDefault();
        var p = canvasPoint(canvas, e);
        if (current.tool === 'pen') current.points.push(p);
        else { current.x1 = p.x; current.y1 = p.y; }
        redraw();
      }
      function up() {
        if (!current) return;
        shapes.push(current);
        current = null;
        redraw();
      }
      canvas.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      canvas.addEventListener('touchstart', down, { passive: false });
      canvas.addEventListener('touchmove', move, { passive: false });
      canvas.addEventListener('touchend', up);
    }

    function drawShape(ctx, s) {
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (s.tool === 'pen') {
        ctx.beginPath();
        s.points.forEach(function (pt, i) { i ? ctx.lineTo(pt.x, pt.y) : ctx.moveTo(pt.x, pt.y); });
        ctx.stroke();
      } else if (s.tool === 'rect') {
        ctx.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
      } else if (s.tool === 'arrow') {
        var dx = s.x1 - s.x0, dy = s.y1 - s.y0;
        var ang = Math.atan2(dy, dx);
        var head = Math.max(10, s.size * 3);
        ctx.beginPath();
        ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x1 - head * Math.cos(ang - Math.PI / 6), s.y1 - head * Math.sin(ang - Math.PI / 6));
        ctx.lineTo(s.x1 - head * Math.cos(ang + Math.PI / 6), s.y1 - head * Math.sin(ang + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      }
    }

    function redraw() {
      annoCtx.clearRect(0, 0, annoCanvas.width, annoCanvas.height);
      shapes.forEach(function (s) { drawShape(annoCtx, s); });
      if (current) drawShape(annoCtx, current);
    }

    function compositeCanvas() {
      var out = document.createElement('canvas');
      out.width = baseCanvas.width;
      out.height = baseCanvas.height;
      var ctx = out.getContext('2d');
      ctx.drawImage(baseCanvas, 0, 0);
      ctx.drawImage(annoCanvas, 0, 0);
      return out;
    }
    function compositeDataUrl() {
      try { return compositeCanvas().toDataURL('image/png'); }
      catch (e) { return null; } // tainted canvas (cross-origin content)
    }

    // -- Context collection -------------------------------------------------
    function cssPath(node) {
      if (!node || node.nodeType !== 1) return '';
      var parts = [];
      var cur = node;
      while (cur && cur.nodeType === 1 && parts.length < 6) {
        var sel = cur.nodeName.toLowerCase();
        if (cur.id) { sel += '#' + cur.id; parts.unshift(sel); break; }
        var cls = (cur.className && typeof cur.className === 'string')
          ? '.' + cur.className.trim().split(/\s+/).slice(0, 2).join('.') : '';
        if (cls && cls !== '.') sel += cls;
        var parent = cur.parentNode;
        if (parent) {
          var sibs = Array.prototype.filter.call(parent.children, function (c) { return c.nodeName === cur.nodeName; });
          if (sibs.length > 1) sel += ':nth-of-type(' + (Array.prototype.indexOf.call(sibs, cur) + 1) + ')';
        }
        parts.unshift(sel);
        cur = parent;
      }
      return parts.join(' > ');
    }

    function parseUA() {
      var ua = navigator.userAgent;
      var browser = 'Unknown', m;
      if ((m = ua.match(/Edg\/([\d.]+)/))) browser = 'Edge ' + m[1];
      else if ((m = ua.match(/OPR\/([\d.]+)/))) browser = 'Opera ' + m[1];
      else if ((m = ua.match(/Chrome\/([\d.]+)/)) && !/Edg|OPR/.test(ua)) browser = 'Chrome ' + m[1];
      else if ((m = ua.match(/Firefox\/([\d.]+)/))) browser = 'Firefox ' + m[1];
      else if ((m = ua.match(/Version\/([\d.]+).*Safari/))) browser = 'Safari ' + m[1];
      var os = 'Unknown';
      if (/Windows NT 10/.test(ua)) os = 'Windows 10/11';
      else if (/Windows/.test(ua)) os = 'Windows';
      else if (/Mac OS X ([\d_]+)/.test(ua)) os = 'macOS ' + (RegExp.$1).replace(/_/g, '.');
      else if (/Android ([\d.]+)/.test(ua)) os = 'Android ' + RegExp.$1;
      else if (/(iPhone|iPad).*OS ([\d_]+)/.test(ua)) os = 'iOS ' + (RegExp.$2).replace(/_/g, '.');
      else if (/Linux/.test(ua)) os = 'Linux';
      return { browser: browser, os: os };
    }

    function safeStorage(store) {
      var out = {};
      try {
        for (var i = 0; i < store.length; i++) {
          var k = store.key(i);
          var v = store.getItem(k);
          out[k] = v && v.length > 500 ? v.slice(0, 500) + '…[truncated]' : v;
        }
      } catch (e) { out.__error = String(e); }
      return out;
    }

    function collectContext(opts) {
      var p = parseUA();
      var rect = selectedElement ? selectedElement.getBoundingClientRect() : null;
      var nav = performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
      var ctx = {
        title: opts.title || '(no title)',
        description: opts.description || '',
        severity: opts.severity || '',
        environment: opts.environment || '',
        url: location.href,
        referrer: document.referrer || '(none)',
        timestamp: new Date().toISOString(),
        page: { title: document.title, charset: document.characterSet },
        browser: p.browser,
        os: p.os,
        userAgent: navigator.userAgent,
        uaData: uaData,
        language: navigator.language,
        languages: (navigator.languages || []).join(', '),
        platform: navigator.platform,
        cores: navigator.hardwareConcurrency,
        memory: navigator.deviceMemory ? navigator.deviceMemory + ' GB' : 'n/a',
        online: navigator.onLine,
        viewport: {
          width: window.innerWidth, height: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
          orientation: (screen.orientation && screen.orientation.type) || 'n/a'
        },
        screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
        timing: nav ? {
          domContentLoaded: Math.round(nav.domContentLoadedEventEnd) + ' ms',
          load: Math.round(nav.loadEventEnd) + ' ms',
          type: nav.type
        } : null,
        element: selectedElement ? {
          selector: cssPath(selectedElement),
          tag: selectedElement.nodeName.toLowerCase(),
          id: selectedElement.id || '',
          classes: (typeof selectedElement.className === 'string') ? selectedElement.className : '',
          rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
          text: (selectedElement.innerText || '').trim().slice(0, 200),
          outerHTML: selectedElement.outerHTML.slice(0, 1500)
        } : null,
        consoleErrors: consoleLog.filter(function (l) { return l.level === 'error' || l.level === 'warn'; }),
        consoleAll: consoleLog,
        jsErrors: errorLog,
        networkErrors: networkLog
      };
      if (opts.includeSensitive) {
        ctx.cookies = document.cookie || '(none / httpOnly only)';
        ctx.localStorage = safeStorage(window.localStorage);
        ctx.sessionStorage = safeStorage(window.sessionStorage);
      }
      return ctx;
    }

    // -- Report rendering ---------------------------------------------------
    function fence(s, lang) { return '```' + (lang || '') + '\n' + s + '\n```'; }

    function buildMarkdown(c, imageNote) {
      var L = [];
      L.push('# 🐞 ' + c.title);
      L.push('');
      var badges = [];
      if (c.severity) badges.push('**Severity:** ' + c.severity);
      if (c.environment) badges.push('**Environment:** ' + c.environment);
      if (badges.length) { L.push(badges.join(' · ')); L.push(''); }
      if (c.description) { L.push('## Description'); L.push(c.description); L.push(''); }
      if (imageNote) { L.push('## Screenshot'); L.push('_Annotated screenshot is attached / embedded in this paste._'); L.push(''); }
      L.push('## Environment');
      L.push('| Field | Value |');
      L.push('| --- | --- |');
      if (c.environment) L.push('| Environment | ' + c.environment + ' |');
      if (c.severity) L.push('| Severity | ' + c.severity + ' |');
      L.push('| URL | ' + c.url + ' |');
      L.push('| Referrer | ' + c.referrer + ' |');
      L.push('| Captured | ' + c.timestamp + ' |');
      L.push('| Browser | ' + c.browser + ' |');
      L.push('| OS | ' + c.os + ' |');
      L.push('| Viewport | ' + c.viewport.width + '×' + c.viewport.height + ' @ ' + c.viewport.dpr + 'x DPR (' + c.viewport.orientation + ') |');
      L.push('| Screen | ' + c.screen.width + '×' + c.screen.height + ', ' + c.screen.colorDepth + '-bit |');
      L.push('| Language | ' + c.language + ' |');
      L.push('| CPU cores | ' + c.cores + ' |');
      L.push('| Device memory | ' + c.memory + ' |');
      L.push('| Online | ' + c.online + ' |');
      if (c.timing) L.push('| Page load | ' + c.timing.load + ' (DCL ' + c.timing.domContentLoaded + ') |');
      L.push('');
      L.push('<details><summary>Full user agent</summary>');
      L.push('');
      L.push('`' + c.userAgent + '`');
      L.push('');
      L.push('</details>');
      L.push('');

      if (c.element) {
        L.push('## Selected element');
        L.push('- **Selector:** `' + c.element.selector + '`');
        if (c.element.rect) L.push('- **Position:** x=' + c.element.rect.x + ' y=' + c.element.rect.y + ' · ' + c.element.rect.w + '×' + c.element.rect.h + ' px');
        if (c.element.text) L.push('- **Text:** ' + c.element.text);
        L.push('');
        L.push(fence(c.element.outerHTML, 'html'));
        L.push('');
      }

      function logSection(title, arr, fmt) {
        L.push('## ' + title + ' (' + arr.length + ')');
        if (!arr.length) { L.push('_None captured after the widget was opened._'); L.push(''); return; }
        L.push(fence(arr.map(fmt).join('\n'), ''));
        L.push('');
      }
      logSection('Console errors & warnings', c.consoleErrors, function (e) {
        return '[' + e.level.toUpperCase() + '] ' + e.time + '  ' + e.text;
      });
      logSection('Uncaught JS errors', c.jsErrors, function (e) {
        return '[' + e.type + '] ' + e.time + '  ' + e.message + (e.source ? ' @ ' + e.source : '') + (e.stack ? '\n' + e.stack : '');
      });
      logSection('Failed network requests', c.networkErrors, function (e) {
        return e.time + '  ' + e.method + ' ' + e.url + '  → ' + e.status + ' (' + e.ms + 'ms)';
      });

      if (c.cookies !== undefined) {
        L.push('## Cookies');
        L.push(fence(c.cookies, ''));
        L.push('');
        L.push('## localStorage');
        L.push(fence(JSON.stringify(c.localStorage, null, 2), 'json'));
        L.push('');
        L.push('## sessionStorage');
        L.push(fence(JSON.stringify(c.sessionStorage, null, 2), 'json'));
        L.push('');
      }

      L.push('---');
      L.push('_Generated by Bug Reporter — paste into Jira / Azure DevOps for an AI agent to pick up._');
      return L.join('\n');
    }

    function esc(s) {
      return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function buildHtml(c, imgDataUrl) {
      var h = [];
      h.push('<div style="font-family:sans-serif">');
      h.push('<h1>🐞 ' + esc(c.title) + '</h1>');
      var badges = [];
      if (c.severity) badges.push('<b>Severity:</b> ' + esc(c.severity));
      if (c.environment) badges.push('<b>Environment:</b> ' + esc(c.environment));
      if (badges.length) h.push('<p>' + badges.join(' &nbsp;·&nbsp; ') + '</p>');
      if (c.description) h.push('<p>' + esc(c.description).replace(/\n/g, '<br>') + '</p>');
      if (imgDataUrl) h.push('<p><img src="' + imgDataUrl + '" alt="annotated screenshot" style="max-width:100%"></p>');
      h.push('<h2>Environment</h2><ul>');
      if (c.environment) h.push('<li><b>Environment:</b> ' + esc(c.environment) + '</li>');
      if (c.severity) h.push('<li><b>Severity:</b> ' + esc(c.severity) + '</li>');
      h.push('<li><b>URL:</b> ' + esc(c.url) + '</li>');
      h.push('<li><b>Browser:</b> ' + esc(c.browser) + '</li>');
      h.push('<li><b>OS:</b> ' + esc(c.os) + '</li>');
      h.push('<li><b>Viewport:</b> ' + c.viewport.width + '×' + c.viewport.height + ' @ ' + c.viewport.dpr + 'x</li>');
      h.push('<li><b>Screen:</b> ' + c.screen.width + '×' + c.screen.height + '</li>');
      h.push('<li><b>Captured:</b> ' + c.timestamp + '</li>');
      h.push('</ul>');
      if (c.element) {
        h.push('<h2>Selected element</h2>');
        h.push('<p><code>' + esc(c.element.selector) + '</code></p>');
        h.push('<pre style="background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto"><code>' + esc(c.element.outerHTML) + '</code></pre>');
      }
      function htmlLog(title, arr, fmt) {
        h.push('<h2>' + title + ' (' + arr.length + ')</h2>');
        if (!arr.length) { h.push('<p><i>None captured.</i></p>'); return; }
        h.push('<pre style="background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto"><code>' + esc(arr.map(fmt).join('\n')) + '</code></pre>');
      }
      htmlLog('Console errors & warnings', c.consoleErrors, function (e) { return '[' + e.level.toUpperCase() + '] ' + e.text; });
      htmlLog('Uncaught JS errors', c.jsErrors, function (e) { return e.message + (e.stack ? '\n' + e.stack : ''); });
      htmlLog('Failed network requests', c.networkErrors, function (e) { return e.method + ' ' + e.url + ' → ' + e.status; });
      if (c.cookies !== undefined) {
        h.push('<h2>Cookies</h2><pre style="background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto"><code>' + esc(c.cookies) + '</code></pre>');
        h.push('<h2>localStorage</h2><pre style="background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto"><code>' + esc(JSON.stringify(c.localStorage, null, 2)) + '</code></pre>');
        h.push('<h2>sessionStorage</h2><pre style="background:#f6f8fa;padding:8px;border-radius:6px;overflow:auto"><code>' + esc(JSON.stringify(c.sessionStorage, null, 2)) + '</code></pre>');
      }
      h.push('<hr><p><i>Generated by Bug Reporter.</i></p></div>');
      return h.join('');
    }

    // -- Clipboard ----------------------------------------------------------
    function setStatus(node, msg, kind) {
      node.textContent = msg;
      node.className = 'status' + (kind ? ' ' + kind : '');
    }

    function copyReport(opts) {
      setStatus(opts.status, 'Building report…', '');
      var ctx = collectContext(opts);
      var imgDataUrl = compositeDataUrl(); // null if the canvas is tainted
      var markdown = buildMarkdown(ctx, !!imgDataUrl);
      var html = buildHtml(ctx, imgDataUrl);

      var canRich = typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write;
      if (canRich) {
        var item = new ClipboardItem({
          'text/plain': new Blob([markdown], { type: 'text/plain' }),
          'text/html': new Blob([html], { type: 'text/html' })
        });
        navigator.clipboard.write([item]).then(function () {
          setStatus(opts.status, '✓ Copied! Paste into your ticket (Ctrl/Cmd+V).', 'ok');
        }).catch(function (e) {
          fallbackCopy(markdown, opts.status);
        });
      } else {
        fallbackCopy(markdown, opts.status);
      }
    }

    function fallbackCopy(text, status) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          setStatus(status, '✓ Copied text (image not supported here — use ⬇ PNG).', 'ok');
        }).catch(function () { execCopy(text, status); });
      } else { execCopy(text, status); }
    }

    function execCopy(text, status) {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); setStatus(status, '✓ Copied text to clipboard.', 'ok'); }
      catch (e) { setStatus(status, 'Copy failed — use the download buttons.', 'err'); }
      document.body.removeChild(ta);
    }

    function downloadDataUrl(dataUrl, name) {
      var a = document.createElement('a'); a.href = dataUrl; a.download = name; a.click();
    }
    function downloadText(text, name) {
      downloadDataUrl('data:text/markdown;charset=utf-8,' + encodeURIComponent(text), name);
    }

    // -- Public -------------------------------------------------------------
    return {
      open: function () {
        if (!rootHost) mount();
        if (state === 'idle' || !shadow.querySelector('.panel')) renderPanel();
      },
      init: function () { mount(); renderPanel(); }
    };
  })();

  window.__bugReporter = BugReporter;
  BugReporter.init();
})();
