# WDIO Automation Driver — Design

**Date:** 2026-07-30
**Status:** Approved (approach and constraints confirmed with project owner)

## Goal

Add an opt-in WebdriverIO (WDIO) backend to chrome-devtools-mcp so user-visible
browser actions (click, fill, navigate, keys, …) can execute through WDIO
commands instead of Puppeteer — with **zero change to existing behavior when
the feature is not enabled**, and full tool functionality when it is.

## Constraints (from owner)

1. Enhancement only — existing Puppeteer behavior must be untouched by default.
2. Full functionality in WDIO mode (no degraded tool set).
3. Local Chrome only. Remote grids (Sauce Labs, etc.) are out of scope.
4. Hybrid execution is acceptable: actions via WDIO, deep diagnostics via CDP.
5. Activation: CLI flag sets the default; a runtime tool can switch drivers.

## Architecture

### The driver seam

The tools split naturally into two groups:

- **Actions** (concentrated in `src/tools/input.ts` and the navigation calls
  in `src/tools/pages.ts`): click, click_at, hover, fill, fill_form, drag,
  type_text, press_key, upload_file, navigate (url/back/forward/reload),
  new_page's initial load.
- **Diagnostics** (everything else): traces, heap snapshots, network,
  console, screenshots, emulation, screencast, extensions, snapshots.

Only actions get a driver abstraction. Diagnostics keep their existing
Puppeteer/CDP path in both modes — that is what makes full parity possible.

### Shared Chrome, two clients

The browser lifecycle does not change by default: Puppeteer launches (or
connects to) Chrome exactly as today. When WDIO mode activates, a WDIO
session is **attached to the same Chrome** using chromedriver's
`goog:chromeOptions.debuggerAddress` capability (host:port parsed from
`browser.wsEndpoint()`). Both clients stay connected; switching drivers at
runtime is a state flip, not a reconnect.

**Transport caveat:** the server launches Chrome with a pipe transport
(`pipe: true` in `src/browser.ts`), which exposes no TCP debug port, so
chromedriver cannot attach. Therefore:

- When the server starts with `--automation-driver wdio`, Chrome is launched
  with `pipe: false` (WebSocket transport) so a TCP port exists. This is the
  only lifecycle difference, and it is gated behind the flag.
- Browsers connected via `--browser-url`, `--ws-endpoint`, or
  `--auto-connect` always have a TCP endpoint; runtime switching works.
- Runtime switching to WDIO on a default-started (pipe) server returns an
  actionable error: restart with `--automation-driver wdio` or connect via
  `--browser-url`. Detection: `browser.wsEndpoint()` returns an empty string
  for pipe transports.

```
MCP server
 ├─ launches Chrome (unchanged, Puppeteer)
 ├─ CDP/Puppeteer ── diagnostics: traces, heap, network, console, screenshots
 └─ ACTION LAYER ── AutomationDriver interface
      ├─ PuppeteerDriver (default; existing code moved verbatim)
      └─ WdioDriver ── WDIO session attached via debuggerAddress
```

### New module: `src/drivers/`

```ts
// AutomationDriver.ts
interface AutomationDriver {
  readonly name: 'puppeteer' | 'wdio';
  navigate(page: McpPage, url: string, opts: {timeout?: number}): Promise<void>;
  goBack(page: McpPage, opts): Promise<void>;
  goForward(page: McpPage, opts): Promise<void>;
  reload(
    page: McpPage,
    opts: {ignoreCache?: boolean; timeout?: number},
  ): Promise<void>;
  click(
    page: McpPage,
    handle: ElementHandle,
    opts: {dblClick?: boolean},
  ): Promise<void>;
  clickAt(
    page: McpPage,
    x: number,
    y: number,
    opts: {dblClick?: boolean},
  ): Promise<void>;
  hover(page: McpPage, handle: ElementHandle): Promise<void>;
  fill(
    page: McpPage,
    handle: ElementHandle,
    value: string,
    opts: {timeout?: number},
  ): Promise<void>;
  selectOption(
    page: McpPage,
    handle: ElementHandle,
    value: string,
  ): Promise<void>;
  drag(page: McpPage, from: ElementHandle, to: ElementHandle): Promise<void>;
  typeText(page: McpPage, text: string, submitKey?: string): Promise<void>;
  pressKey(page: McpPage, key: KeyInput, modifiers: KeyInput[]): Promise<void>;
  uploadFile(
    page: McpPage,
    handle: ElementHandle,
    filePath: string,
  ): Promise<void>;
  dispose(): Promise<void>;
}
```

- **PuppeteerDriver** — the existing call sites
  (`handle.asLocator().click()`, `pptrPage.keyboard.*`, `pptrPage.goto` …)
  moved behind the interface, byte-for-byte semantics.
- **WdioDriver** — lazily created on first use. Maps each method to WDIO:
  `browser.url()/back()/forward()/refresh()`, `$(el).click()/moveTo()/
setValue()/selectByAttribute('value', …)/dragAndDrop()`, `browser.keys()`,
  `browser.action('pointer')` for coordinates.

Tool handlers change from direct Puppeteer calls to
`context.getAutomationDriver().<action>(page, …)`. The
`waitForEventsAfterAction()` wrapper (navigation/dialog settling) is
driver-agnostic and continues to wrap every action, so response semantics
are identical in both modes. Element handles are still resolved from
snapshot uids exactly as today; the driver receives the resolved
`ElementHandle`.

### Element bridging (uid → WDIO element)

Snapshot uids resolve to Puppeteer `ElementHandle`s (via CDP backendNodeId).
WdioDriver bridges a handle to a WDIO element without re-querying:

1. `page.evaluate(el => { window.__cdm_wdio_el = el }, handle)` stashes the
   DOM node in a short-lived global.
2. WDIO resolves it with a function selector:
   `browser.$(() => window.__cdm_wdio_el)`.
3. The global is cleared in a `finally` block.

Same node, no selector guessing, no snapshot format changes.

### Tab targeting

Before each WDIO action, the driver switches the WDIO session to the window
corresponding to the target `McpPage`. chromedriver window handles are
`CDwindow-<targetId>`; the CDP targetId comes from the Puppeteer page's
target. If the handle lookup fails (e.g. exotic targets), the driver falls
back to matching by URL+title, and errors clearly if the tab cannot be found.

### Activation

- **CLI:** `--automationDriver <puppeteer|wdio>` (kebab `--automation-driver`
  accepted by yargs), default `puppeteer`. Omitting the flag yields today's
  behavior exactly.
- **Runtime tool:** `select_automation_driver` (category: navigation —
  pragmatic fit; there is no configuration category) with
  `driver: 'puppeteer' | 'wdio'`. Reports the active driver. Switching to
  WDIO creates the session lazily; switching away leaves it connected but
  idle (cheap to switch back); server shutdown disposes it.
- Driver state lives on `McpContext` (`getAutomationDriver()` /
  `selectAutomationDriver(name)` added to the tools `Context` interface).

### Dependencies

- `webdriverio` added to **`optionalDependencies`** and imported only via
  dynamic `import('webdriverio')` on first WDIO activation.
- Kept **external** in `rollup.config.mjs` so the published bundle does not
  grow.
- If the import fails, the tool/flag produces an actionable error
  (`npm install webdriverio`) without crashing the server.
- WDIO v9 manages chromedriver automatically for local Chrome; no separate
  chromedriver dependency.
- The WDIO session is created with `unhandledPromptBehavior: 'ignore'` so
  chromedriver never auto-dismisses dialogs — dialog handling stays on the
  existing CDP path.

## Tool coverage matrix (WDIO mode)

| Tool                                                                                                                                                | Path                                                                                                     |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| click, hover, fill, fill_form, drag, type_text, press_key, click_at                                                                                 | WDIO                                                                                                     |
| navigate_page (url/back/forward/reload), new_page's initial load                                                                                    | WDIO (page creation itself stays Puppeteer for collector wiring)                                         |
| upload_file                                                                                                                                         | WDIO `setValue` on file input; falls back to the existing Puppeteer file-chooser path for proxy elements |
| fill on combobox/select                                                                                                                             | option value resolved as today, then WDIO `selectByAttribute`                                            |
| handle_dialog, wait_for, resize_page, emulation, screenshots, snapshots, network, console, performance, memory, extensions, screencast, script eval | unchanged (CDP) — identical in both modes                                                                |

`navigateWithInterception`'s allowList (CDP request interception) continues
to work in WDIO mode because interception is browser-level CDP, independent
of which client issues the navigation.

## Error handling

- WDIO import missing → actionable error, server keeps running on Puppeteer.
- WDIO session creation failure (chromedriver download blocked, port issues)
  → error from `select_automation_driver` / first action; driver remains
  Puppeteer.
- WDIO session dies mid-run → one automatic re-attach attempt, then error
  instructing the user to re-select the driver.
- Element action failures map to the same user-facing messages as today
  (`handleActionError`), so agent-visible behavior is stable.
- Stashed `window.__cdm_wdio_el` globals cleared in `finally`.

## Testing

- **Unit:** `WdioDriver` tested against a stubbed WDIO browser object
  (interface-level: correct command per action, window switching, stash
  cleanup, key mapping). Driver selection/fallback logic tested in
  `McpContext` tests.
- **Existing suite:** must pass unchanged — proves the Puppeteer path is
  untouched (PuppeteerDriver is a move, not a rewrite).
- **E2E (gated):** a WDIO-mode smoke test (navigate, snapshot, click, fill)
  behind an env var (`TEST_WDIO=1`) since it downloads chromedriver;
  excluded from default CI.

## Out of scope

- Remote WebDriver endpoints / Sauce Labs.
- Firefox/Safari via WDIO.
- Replacing diagnostics (traces, heap, network) with BiDi equivalents.
