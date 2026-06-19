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
4. Annotate with **pen / rectangle / arrow**, pick colours, undo/clear.
5. Add a **title & description**.
6. **Copy bug report to clipboard** → paste into your ticket.

The copy uses a rich + plain clipboard:
- `text/html` — formatted report with the **screenshot embedded inline** (pastes
  into Jira/ADO rich editors with the image).
- `text/plain` — Markdown fallback for plain-text fields and AI agents.

Backup buttons let you download the **PNG** and the **Markdown** report directly.

## What's collected

- Annotated screenshot (PNG)
- URL, referrer, page title, timestamp
- Browser & OS (parsed UA + high-entropy `userAgentData` when available)
- Viewport, screen, DPR, orientation, CPU cores, device memory, online status
- Page load timing
- Selected element: CSS selector, tag, id/classes, bounding box, text, outerHTML
- Console errors & warnings (and full console log)
- Uncaught JS errors & unhandled promise rejections
- Failed network requests (fetch + XHR, status ≥ 400 or network error)
- **Optional** (toggle, on by default): cookies, localStorage, sessionStorage

> ⚠️ Cookies & storage may contain auth tokens. There's a toggle in the widget —
> turn it off for tickets shared beyond your team.

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
