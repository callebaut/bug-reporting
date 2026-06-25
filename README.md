# 🐞 Bug Reporter

A **bookmarklet-loaded widget** for logging rich bug reports from any web page —
modelled on how [openfed/AccessibilityCheck](https://github.com/openfed/AccessibilityCheck)
ships its auditor overlay via a bookmarklet.

Click the bookmark → a small widget opens on the page. Pick an element, it gets
screenshotted, you draw on it, add a title & description, and copy a complete
bug report (screenshot + environment + console/network errors + cookies/storage)
to your clipboard. Paste it straight into a **Jira** or **Azure DevOps** ticket so
an AI agent has everything it needs to pick up the fix.

## How it works

Same pattern as AccessibilityCheck:

1. A **bookmarklet** (a `javascript:` snippet saved as a bookmark) injects a
   `<script>` tag pointing at the hosted `bug-reporter.js`.
2. `bug-reporter.js` builds a **Shadow-DOM isolated** widget on the current page
   (so it can't clash with the host site's CSS) and loads its only dependency,
   `vendor/html2canvas.min.js`, from the same directory.

```
docs/
├── index.html              # landing page: bookmarklet generator + live demo
├── bug-reporter.js         # the widget (what the bookmarklet loads)
└── vendor/
    └── html2canvas.min.js  # screenshot engine (MIT), vendored — no CDN needed
```

## Hosting (GitHub Pages)

1. Push this repo.
2. In **Settings → Pages**, set **Source = Deploy from a branch**, branch =
   your branch (or `main`), folder = **`/docs`**.
3. Your site appears at `https://<user>.github.io/<repo>/`.
   The widget is at `https://<user>.github.io/<repo>/bug-reporter.js`.
4. Open the landing page (`index.html`) — it auto-fills that URL and generates a
   ready-to-drag bookmarklet.

## The bookmarklet

```js
javascript:(function(){
  if(window.__bugReporter){window.__bugReporter.open();return;}
  var s=document.createElement('script');
  s.src='https://YOUR-HOST/bug-reporter.js?'+Date.now();
  s.onerror=function(){alert('Bug Reporter failed to load from '+s.src);};
  document.documentElement.appendChild(s);
})();
```

Replace `https://YOUR-HOST/bug-reporter.js` with your hosted URL (the landing
page does this for you).

## Using it

1. Open the buggy page. **Reproduce the bug after** opening the widget so console
   & network errors are captured (see note below).
2. Click the bookmark → widget opens bottom-right.
3. **Select an element** → hover and click the element to screenshot.
4. The screenshot appears as a **thumbnail** in the panel. **Click it** to open the
   annotation pop-up, draw with **pen / rectangle / arrow / text**, choose a
   **colour**, then hit **Done**. Pen/rectangle/arrow have an **S / M / L** width;
   text has its own **font-size picker** and **Bold** toggle. For text, pick the
   **T** tool, tap where you want the label, and type in the live editor box
   (Enter commits, Shift+Enter for a new line, Esc cancels); text uses the selected
   colour with a crisp outline. **Click an existing text label with the T tool to
   edit it** (emptying it deletes it). Use the **✋ Move** tool to grab and drag any
   placed element (pen, box, arrow, or text) to reposition it. With an element
   selected, press **Delete/Backspace** or click the **🗑 Delete** button (it
   turns red when something is selected) to remove it.
5. Fill in **Title**, **Description**, **Expected results**, **Severity** and
   **Environment**.
6. **Copy bug report to clipboard** → paste into your ticket.

The copy uses a rich + plain clipboard:
- `text/html` — formatted report with the **screenshot embedded inline** (pastes
  into Jira/ADO rich editors with the image).
- `text/plain` — Markdown fallback for plain-text fields and AI agents.

Backup buttons let you download the **PNG** and the **Markdown** report directly.

## Severity & environment

The report has a **Severity** dropdown and an **Environment** field that is
**auto-detected from the page URL** (e.g. `localhost` → Local, `staging.` /
`uat` → Staging, otherwise Production). The detected environment is pre-selected
but you can override it in the widget before copying. Both appear at the top of
the copied report.

## Configuration (per user, no backend)

The widget reads `window.__bugReporterConfig` if present, falling back to
built-in defaults. The **bookmarklet sets this global before loading the
script**, so each person's bookmarklet carries their own rules — no server
needed. The landing page has a small form — severity list, default severity, and
add/remove/reorder environment rules — that bakes the config into the generated
bookmarklet.

```js
window.__bugReporterConfig = {
  severities: ['Blocker', 'Critical', 'Major', 'Minor', 'Trivial'],
  defaultSeverity: 'Major',
  environments: [            // ordered; first regex match against the URL wins
    { match: 'localhost|127\\.0\\.0\\.1|\\.local', label: 'Local' },
    { match: 'staging|uat|stage|stg|acc|test',     label: 'Staging' },
    { match: '.*',                                  label: 'Production' }
  ]
};
```

The landing-page form **remembers your entries in the browser** (`localStorage`),
so you don't have to re-enter the host URL, severities, default severity, or
environment rules each visit. Use **Reset to defaults** to clear them.

`match` is a case-insensitive regular expression tested against the full URL.
Omit a key (or pass an empty array) to use the built-in default for it. The
generated bookmarklet looks like:

```js
javascript:(function(){
  window.__bugReporterConfig={ ...your config... };
  if(window.__bugReporter){window.__bugReporter.open();return;}
  var s=document.createElement('script');
  s.src='https://YOUR-HOST/bug-reporter.js?'+Date.now();
  document.documentElement.appendChild(s);
})();
```

For **team-wide** rules instead of per-person, host a small `config.js` that sets
`window.__bugReporterConfig` and load it from the bookmarklet before
`bug-reporter.js`.

## What's collected

- Title, description, **expected results**, **severity**, **environment** (auto-detected from URL)
- Annotated screenshot (PNG)
- URL, referrer, page title, timestamp
- Browser & OS (parsed UA + high-entropy `userAgentData` when available)
- Viewport, screen, DPR, orientation, CPU cores, device memory, online status
- Page load timing
- Selected element: CSS selector, tag, id/classes, bounding box, text, outerHTML
- Console errors & warnings (and full console log)
- Uncaught JS errors & unhandled promise rejections
- Failed network requests (fetch + XHR, status ≥ 400 or network error)
- **Optional** (toggle, on by default): cookies, localStorage, sessionStorage,
  and configured response headers

> ⚠️ Cookies & storage may contain auth tokens. There's a toggle in the widget —
> turn it off for tickets shared beyond your team.

### Collecting only what matters (allowlists)

By default the toggle grabs **all** cookies/storage. On the bookmarklet page
(section *“Choose which data to collect”*) you can list the **names** that
matter, and the widget then collects **only those** — per category:

```js
window.__bugReporterConfig = {
  collect: {
    cookies:        ['sessionId', 'cartId'],   // only these cookies
    localStorage:   ['featureFlags'],          // only these keys
    sessionStorage: [],                        // empty = collect nothing
    headers:        ['x-app-version']          // response headers (see note)
  }
};
```

Everything sensitive is **opt-in**: a blank category collects **nothing**. So
cookies, localStorage, sessionStorage and headers are only included when you
list names. A listed name that isn't present is reported as `(not set)`.

**Headers caveat:** browsers can't read a page's *outgoing request* headers
(e.g. `Authorization`) from JavaScript. Only **response** headers of the current
page are captured — via a best-effort same-origin `fetch`, and only when you
list header names. They appear under a *Response headers* section in the report.

## Capturing errors from page load

A bookmarklet only runs when clicked, so it hooks `console`, `window.onerror`,
`unhandledrejection`, `fetch` and `XMLHttpRequest` **from that moment on**. The
intended workflow is: open the widget, then reproduce the bug.

To capture from the very first paint on your own dev/staging site, add the early
snippet shown on the landing page to the top of your `<head>`.

## Limitations

- **html2canvas** reconstructs the DOM into a canvas; it can't perfectly render
  every CSS feature, cross-origin images may be blank, and `<canvas>`/WebGL/iframe
  content may not appear. It's good for layout/visual bugs.
- Clipboard image paste depends on the target editor; use the **PNG** download as
  a fallback if an editor strips the inline image.
- `httpOnly` cookies are not readable from JavaScript and won't be included.

## License

Widget code: do as you like. Bundled `html2canvas` is MIT (Niklas von Hertzen).
