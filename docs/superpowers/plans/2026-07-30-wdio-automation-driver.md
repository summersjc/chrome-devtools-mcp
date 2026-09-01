# WDIO Automation Driver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in WebdriverIO backend so user-visible browser actions run through WDIO commands, with zero change to default (Puppeteer) behavior.

**Architecture:** An `AutomationDriver` interface at the action layer. `PuppeteerDriver` is the existing code moved behind the interface. `WdioDriver` attaches a WDIO session to the _same_ Chrome via chromedriver's `goog:chromeOptions.debuggerAddress`. Diagnostics (traces, network, console, screenshots, emulation) stay on the existing Puppeteer/CDP path in both modes. Spec: `docs/superpowers/specs/2026-07-30-wdio-automation-driver-design.md`.

**Tech Stack:** TypeScript (strict), Puppeteer, webdriverio v9 (optionalDependency, dynamic import), node:test + sinon, real-Chrome test harness (`tests/utils.ts` `withMcpContext`).

## Global Constraints

- Default behavior must be byte-for-byte unchanged: no flag → Puppeteer path, pipe transport, same tool output strings.
- `webdriverio` is an `optionalDependency`, loaded only via dynamic `import('webdriverio')` at WDIO activation; never bundled (it lives outside `src/third_party/`, which is the only thing rollup bundles).
- Local Chrome only; hybrid allowed (element resolution/diagnostics via CDP, actions via WDIO).
- Repo TS rules (AGENTS.md): no `any`, no `as`, no `!` non-null assertion, no ts-ignore/ts-expect-error comments. Pre-existing casts being _moved_ keep their file; do not introduce new ones. Use type predicates and `ElementHandle.toElement()` instead.
- Only npm scripts for commands: `npm run build`, `npm run test tests/<file>.ts`, `npm run format`.
- Chrome launched by this server uses `pipe: true` (`src/browser.ts:225`) → no TCP debug port. WDIO can only attach when the server started with `--automation-driver wdio` (launches with `pipe: false`) or when connected via `--browser-url`/`--ws-endpoint`/`--auto-connect`. Detection: `browser.wsEndpoint() === ''` means not attachable.
- All user-facing error strings in this plan are exact; copy them verbatim.

---

### Task 1: AutomationDriver interface + PuppeteerDriver

**Files:**

- Create: `src/drivers/AutomationDriver.ts`
- Create: `src/drivers/PuppeteerDriver.ts`
- Test: `tests/drivers/PuppeteerDriver.test.ts`

**Interfaces:**

- Consumes: `ContextPage` from `src/tools/ToolDefinition.ts`, `ElementHandle`/`KeyInput` from `src/third_party/index.ts`.
- Produces: `AutomationDriver`, `WdioSession`, `WdioElement`, `NavigateOptions` types; `PuppeteerDriver` class; `uploadFileViaFileChooser(page, handle, filePath)` helper. Later tasks call driver methods with these exact signatures.

- [ ] **Step 1: Create the interface file**

`src/drivers/AutomationDriver.ts` (license header same as other files):

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ElementHandle, KeyInput} from '../third_party/index.js';
import type {ContextPage} from '../tools/ToolDefinition.js';

export type AutomationDriverName = 'puppeteer' | 'wdio';

export interface NavigateOptions {
  timeout?: number;
}

export interface ReloadOptions extends NavigateOptions {
  ignoreCache?: boolean;
}

export interface ClickOptions {
  dblClick?: boolean;
}

export interface FillOptions {
  timeout?: number;
}

/**
 * Executes user-visible browser actions. Diagnostics (network, console,
 * traces, screenshots) intentionally stay on the Puppeteer/CDP path and are
 * not part of this interface.
 */
export interface AutomationDriver {
  readonly name: AutomationDriverName;
  navigate(
    page: ContextPage,
    url: string,
    options?: NavigateOptions,
  ): Promise<void>;
  goBack(page: ContextPage, options?: NavigateOptions): Promise<void>;
  goForward(page: ContextPage, options?: NavigateOptions): Promise<void>;
  reload(page: ContextPage, options?: ReloadOptions): Promise<void>;
  click(
    page: ContextPage,
    handle: ElementHandle<Element>,
    options?: ClickOptions,
  ): Promise<void>;
  clickAt(
    page: ContextPage,
    x: number,
    y: number,
    options?: ClickOptions,
  ): Promise<void>;
  hover(page: ContextPage, handle: ElementHandle<Element>): Promise<void>;
  fill(
    page: ContextPage,
    handle: ElementHandle<Element>,
    value: string,
    options?: FillOptions,
  ): Promise<void>;
  selectOption(
    page: ContextPage,
    handle: ElementHandle<Element>,
    value: string,
  ): Promise<void>;
  drag(
    page: ContextPage,
    from: ElementHandle<Element>,
    to: ElementHandle<Element>,
  ): Promise<void>;
  typeText(
    page: ContextPage,
    text: string,
    submitKey?: KeyInput,
  ): Promise<void>;
  pressKey(
    page: ContextPage,
    key: KeyInput,
    modifiers: KeyInput[],
  ): Promise<void>;
  uploadFile(
    page: ContextPage,
    handle: ElementHandle<Element>,
    filePath: string,
  ): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * Minimal structural view of a WebdriverIO session. Kept local so the
 * "webdriverio" package is not a build-time dependency of the type graph.
 */
export interface WdioElement {
  click(): Promise<void>;
  doubleClick(): Promise<void>;
  moveTo(): Promise<void>;
  setValue(value: string): Promise<void>;
  addValue(value: string): Promise<void>;
  selectByAttribute(attribute: string, value: string): Promise<void>;
  dragAndDrop(target: WdioElement): Promise<void>;
}

export interface WdioPointerAction {
  move(options: {x: number; y: number}): WdioPointerAction;
  down(): WdioPointerAction;
  up(): WdioPointerAction;
  pause(ms: number): WdioPointerAction;
  perform(): Promise<void>;
}

export interface WdioSession {
  $(selector: () => Element | undefined): Promise<WdioElement>;
  url(url: string): Promise<unknown>;
  back(): Promise<unknown>;
  forward(): Promise<unknown>;
  refresh(): Promise<unknown>;
  keys(keys: string | string[]): Promise<unknown>;
  action(
    type: 'pointer',
    options?: {parameters: {pointerType: 'mouse'}},
  ): WdioPointerAction;
  switchToWindow(handle: string): Promise<unknown>;
  getWindowHandles(): Promise<string[]>;
  getUrl(): Promise<string>;
  setTimeout(timeouts: {pageLoad?: number}): Promise<unknown>;
  deleteSession(): Promise<unknown>;
}
```

- [ ] **Step 2: Write the failing test**

`tests/drivers/PuppeteerDriver.test.ts` — mirrors `tests/tools/input.test.ts` conventions (withMcpContext + real Chrome + TextSnapshot):

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {PuppeteerDriver} from '../../src/drivers/PuppeteerDriver.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';
import {serverHooks} from '../server.js';
import {html, withMcpContext} from '../utils.js';

describe('drivers/PuppeteerDriver', () => {
  serverHooks();

  it('has the puppeteer name', () => {
    assert.strictEqual(new PuppeteerDriver().name, 'puppeteer');
  });

  it('clicks an element', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(
        html`<button onclick="this.innerText = 'clicked';">test</button>`,
      );
      const mcpPage = context.getSelectedMcpPage();
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const handle = await mcpPage.getElementByUid('1_1');
      const driver = new PuppeteerDriver();
      await driver.click(mcpPage, handle);
      assert.ok(await page.$('text/clicked'));
    });
  });

  it('double clicks an element', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(
        html`<button ondblclick="this.innerText = 'dbl';">test</button>`,
      );
      const mcpPage = context.getSelectedMcpPage();
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const handle = await mcpPage.getElementByUid('1_1');
      const driver = new PuppeteerDriver();
      await driver.click(mcpPage, handle, {dblClick: true});
      assert.ok(await page.$('text/dbl'));
    });
  });

  it('fills an input', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(html`<input type="text" />`);
      const mcpPage = context.getSelectedMcpPage();
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const handle = await mcpPage.getElementByUid('1_1');
      const driver = new PuppeteerDriver();
      await driver.fill(mcpPage, handle, 'hello');
      const value = await page.$eval('input', input => input.value);
      assert.strictEqual(value, 'hello');
    });
  });

  it('navigates', async () => {
    await withMcpContext(async (_response, context) => {
      const mcpPage = context.getSelectedMcpPage();
      const driver = new PuppeteerDriver();
      await driver.navigate(mcpPage, 'about:blank');
      assert.strictEqual(mcpPage.pptrPage.url(), 'about:blank');
    });
  });

  it('types text and presses keys', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(
        html`<input
          type="text"
          autofocus
        />`,
      );
      await page.focus('input');
      const mcpPage = context.getSelectedMcpPage();
      const driver = new PuppeteerDriver();
      await driver.typeText(mcpPage, 'abc');
      await driver.pressKey(mcpPage, 'a', ['Control']);
      await driver.typeText(mcpPage, 'x');
      const value = await page.$eval('input', input => input.value);
      assert.strictEqual(value, 'x');
    });
  });
});
```

Note: `serverHooks()` and `html` come from the existing harness; check `tests/server.ts` exports if the import shape differs (`const server = serverHooks();` is used in tool tests; the return value is only needed when tests reference server URLs — not needed here).

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test tests/drivers/PuppeteerDriver.test.ts`
Expected: FAIL — module `src/drivers/PuppeteerDriver.js` does not exist (build error).

- [ ] **Step 4: Implement PuppeteerDriver**

`src/drivers/PuppeteerDriver.ts` — semantics copied from the current call sites in `src/tools/input.ts` and `src/tools/pages.ts`:

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ElementHandle, KeyInput} from '../third_party/index.js';
import type {ContextPage} from '../tools/ToolDefinition.js';

import type {
  AutomationDriver,
  ClickOptions,
  FillOptions,
  NavigateOptions,
  ReloadOptions,
} from './AutomationDriver.js';

/**
 * Fallback used when an element cannot accept a file directly: click it and
 * wait for a file chooser. Shared by PuppeteerDriver and WdioDriver.
 */
export async function uploadFileViaFileChooser(
  page: ContextPage,
  handle: ElementHandle<Element>,
  filePath: string,
): Promise<void> {
  try {
    const [fileChooser] = await Promise.all([
      page.pptrPage.waitForFileChooser({timeout: 3000}),
      handle.asLocator().click(),
    ]);
    await fileChooser.accept([filePath]);
  } catch {
    throw new Error(
      `Failed to upload file. The element could not accept the file directly, and clicking it did not trigger a file chooser.`,
    );
  }
}

export class PuppeteerDriver implements AutomationDriver {
  readonly name = 'puppeteer';

  async navigate(
    page: ContextPage,
    url: string,
    options?: NavigateOptions,
  ): Promise<void> {
    await page.pptrPage.goto(url, {timeout: options?.timeout});
  }

  async goBack(page: ContextPage, options?: NavigateOptions): Promise<void> {
    await page.pptrPage.goBack({timeout: options?.timeout});
  }

  async goForward(page: ContextPage, options?: NavigateOptions): Promise<void> {
    await page.pptrPage.goForward({timeout: options?.timeout});
  }

  async reload(page: ContextPage, options?: ReloadOptions): Promise<void> {
    await page.pptrPage.reload({
      timeout: options?.timeout,
      ignoreCache: options?.ignoreCache,
    });
  }

  async click(
    page: ContextPage,
    handle: ElementHandle<Element>,
    options?: ClickOptions,
  ): Promise<void> {
    await handle.asLocator().click({
      count: options?.dblClick ? 2 : 1,
    });
  }

  async clickAt(
    page: ContextPage,
    x: number,
    y: number,
    options?: ClickOptions,
  ): Promise<void> {
    await page.pptrPage.mouse.click(x, y, {
      clickCount: options?.dblClick ? 2 : 1,
    });
  }

  async hover(
    page: ContextPage,
    handle: ElementHandle<Element>,
  ): Promise<void> {
    await handle.asLocator().hover();
  }

  async fill(
    page: ContextPage,
    handle: ElementHandle<Element>,
    value: string,
    options?: FillOptions,
  ): Promise<void> {
    let locator = handle.asLocator();
    if (options?.timeout !== undefined) {
      locator = locator.setTimeout(options.timeout);
    }
    await locator.fill(value);
  }

  async selectOption(
    page: ContextPage,
    handle: ElementHandle<Element>,
    value: string,
  ): Promise<void> {
    await handle.asLocator().fill(value);
  }

  async drag(
    page: ContextPage,
    from: ElementHandle<Element>,
    to: ElementHandle<Element>,
  ): Promise<void> {
    await from.drag(to);
    await new Promise(resolve => setTimeout(resolve, 50));
    await to.drop(from);
  }

  async typeText(
    page: ContextPage,
    text: string,
    submitKey?: KeyInput,
  ): Promise<void> {
    await page.pptrPage.keyboard.type(text);
    if (submitKey) {
      await page.pptrPage.keyboard.press(submitKey);
    }
  }

  async pressKey(
    page: ContextPage,
    key: KeyInput,
    modifiers: KeyInput[],
  ): Promise<void> {
    for (const modifier of modifiers) {
      await page.pptrPage.keyboard.down(modifier);
    }
    await page.pptrPage.keyboard.press(key);
    for (const modifier of modifiers.toReversed()) {
      await page.pptrPage.keyboard.up(modifier);
    }
  }

  async uploadFile(
    page: ContextPage,
    handle: ElementHandle<Element>,
    filePath: string,
  ): Promise<void> {
    try {
      const input = await handle.toElement('input');
      await input.uploadFile(filePath);
    } catch {
      // Some sites use a proxy element to trigger file upload instead of
      // a type=file element. In this case, we want to default to
      // Page.waitForFileChooser() and upload the file this way.
      await uploadFileViaFileChooser(page, handle, filePath);
    }
  }

  async dispose(): Promise<void> {}
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test tests/drivers/PuppeteerDriver.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/drivers/AutomationDriver.ts src/drivers/PuppeteerDriver.ts tests/drivers/PuppeteerDriver.test.ts
git commit -m "feat: add AutomationDriver interface and PuppeteerDriver"
```

---

### Task 2: WdioDriver

**Files:**

- Create: `src/drivers/WdioDriver.ts`
- Test: `tests/drivers/WdioDriver.test.ts`

**Interfaces:**

- Consumes: `AutomationDriver`, `WdioSession`, `WdioElement` from Task 1; `uploadFileViaFileChooser` from Task 1; `Browser` from `src/third_party/index.ts`.
- Produces: `WdioDriver` class with constructor `new WdioDriver(browser: Browser, sessionFactory?: (browser: Browser) => Promise<WdioSession>)`, method `ensureSession(): Promise<WdioSession>`, plus all `AutomationDriver` methods. Task 3 constructs it with only `browser`.

- [ ] **Step 1: Write the failing test**

`tests/drivers/WdioDriver.test.ts`. Uses a recording stub session injected via the factory; the page/element bridge runs against the real Chrome from the harness.

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {
  WdioElement,
  WdioPointerAction,
  WdioSession,
} from '../../src/drivers/AutomationDriver.js';
import {WdioDriver} from '../../src/drivers/WdioDriver.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';
import {serverHooks} from '../server.js';
import {html, withMcpContext} from '../utils.js';

interface StubCall {
  method: string;
  args: unknown[];
}

function createStubSession(calls: StubCall[]): WdioSession {
  const element: WdioElement = {
    async click() {
      calls.push({method: 'element.click', args: []});
    },
    async doubleClick() {
      calls.push({method: 'element.doubleClick', args: []});
    },
    async moveTo() {
      calls.push({method: 'element.moveTo', args: []});
    },
    async setValue(value: string) {
      calls.push({method: 'element.setValue', args: [value]});
    },
    async addValue(value: string) {
      calls.push({method: 'element.addValue', args: [value]});
    },
    async selectByAttribute(attribute: string, value: string) {
      calls.push({
        method: 'element.selectByAttribute',
        args: [attribute, value],
      });
    },
    async dragAndDrop(target: WdioElement) {
      calls.push({method: 'element.dragAndDrop', args: [target]});
    },
  };
  const pointerAction: WdioPointerAction = {
    move(options: {x: number; y: number}) {
      calls.push({method: 'action.move', args: [options]});
      return pointerAction;
    },
    down() {
      calls.push({method: 'action.down', args: []});
      return pointerAction;
    },
    up() {
      calls.push({method: 'action.up', args: []});
      return pointerAction;
    },
    pause(ms: number) {
      calls.push({method: 'action.pause', args: [ms]});
      return pointerAction;
    },
    async perform() {
      calls.push({method: 'action.perform', args: []});
    },
  };
  return {
    async $(selector: () => Element | undefined) {
      calls.push({method: '$', args: [selector]});
      return element;
    },
    async url(url: string) {
      calls.push({method: 'url', args: [url]});
    },
    async back() {
      calls.push({method: 'back', args: []});
    },
    async forward() {
      calls.push({method: 'forward', args: []});
    },
    async refresh() {
      calls.push({method: 'refresh', args: []});
    },
    async keys(keys: string | string[]) {
      calls.push({method: 'keys', args: [keys]});
    },
    action() {
      calls.push({method: 'action', args: []});
      return pointerAction;
    },
    async switchToWindow(handle: string) {
      calls.push({method: 'switchToWindow', args: [handle]});
    },
    async getWindowHandles() {
      calls.push({method: 'getWindowHandles', args: []});
      return [];
    },
    async getUrl() {
      calls.push({method: 'getUrl', args: []});
      return 'about:blank';
    },
    async setTimeout(timeouts: {pageLoad?: number}) {
      calls.push({method: 'setTimeout', args: [timeouts]});
    },
    async deleteSession() {
      calls.push({method: 'deleteSession', args: []});
    },
  };
}

function methods(calls: StubCall[]): string[] {
  return calls.map(call => call.method);
}

describe('drivers/WdioDriver', () => {
  serverHooks();

  it('clicks a bridged element and cleans up the stash', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(html`<button>test</button>`);
      const mcpPage = context.getSelectedMcpPage();
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const handle = await mcpPage.getElementByUid('1_1');
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await driver.click(mcpPage, handle);
      assert.ok(methods(calls).includes('element.click'));
      const stash = await page.evaluate(() => window.__cdmWdioEls);
      assert.strictEqual(stash, undefined);
    });
  });

  it('double clicks via doubleClick', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(html`<button>test</button>`);
      const mcpPage = context.getSelectedMcpPage();
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const handle = await mcpPage.getElementByUid('1_1');
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await driver.click(mcpPage, handle, {dblClick: true});
      assert.ok(methods(calls).includes('element.doubleClick'));
    });
  });

  it('navigates with a pageLoad timeout', async () => {
    await withMcpContext(async (_response, context) => {
      const mcpPage = context.getSelectedMcpPage();
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await driver.navigate(mcpPage, 'about:blank', {timeout: 1234});
      const setTimeoutCall = calls.find(call => call.method === 'setTimeout');
      assert.deepStrictEqual(setTimeoutCall?.args[0], {pageLoad: 1234});
      const urlCall = calls.find(call => call.method === 'url');
      assert.deepStrictEqual(urlCall?.args, ['about:blank']);
      assert.ok(methods(calls).includes('switchToWindow'));
    });
  });

  it('maps press_key modifiers to WebDriver key names', async () => {
    await withMcpContext(async (_response, context) => {
      const mcpPage = context.getSelectedMcpPage();
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await driver.pressKey(mcpPage, 'a', ['Control']);
      const keysCall = calls.find(call => call.method === 'keys');
      assert.deepStrictEqual(keysCall?.args[0], ['Control', 'a']);
    });
  });

  it('types text as individual characters', async () => {
    await withMcpContext(async (_response, context) => {
      const mcpPage = context.getSelectedMcpPage();
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await driver.typeText(mcpPage, 'Enter');
      const keysCall = calls.find(call => call.method === 'keys');
      // "Enter" must be typed as characters, not pressed as a key.
      assert.deepStrictEqual(keysCall?.args[0], ['E', 'n', 't', 'e', 'r']);
    });
  });

  it('recreates the session once when it died', async () => {
    await withMcpContext(async (_response, context) => {
      const mcpPage = context.getSelectedMcpPage();
      const calls: StubCall[] = [];
      let created = 0;
      const driver = new WdioDriver(context.browser, async () => {
        created++;
        if (created === 1) {
          const broken = createStubSession(calls);
          broken.url = async () => {
            throw new Error('invalid session id');
          };
          return broken;
        }
        return createStubSession(calls);
      });
      await driver.navigate(mcpPage, 'about:blank');
      assert.strictEqual(created, 2);
      assert.ok(methods(calls).includes('url'));
    });
  });

  it('errors clearly when the browser has no TCP endpoint', async () => {
    await withMcpContext(async (_response, context) => {
      // The test harness launches Chrome with pipe: true, so wsEndpoint()
      // is empty and the default session factory must reject.
      const driver = new WdioDriver(context.browser);
      await assert.rejects(driver.ensureSession(), /no TCP debugging endpoint/);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test tests/drivers/WdioDriver.test.ts`
Expected: FAIL — module `src/drivers/WdioDriver.js` does not exist.

- [ ] **Step 3: Implement WdioDriver**

`src/drivers/WdioDriver.ts`:

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../logger.js';
import type {
  Browser,
  ElementHandle,
  KeyInput,
  Page,
} from '../third_party/index.js';
import type {ContextPage} from '../tools/ToolDefinition.js';

import type {
  AutomationDriver,
  ClickOptions,
  FillOptions,
  NavigateOptions,
  ReloadOptions,
  WdioElement,
  WdioSession,
} from './AutomationDriver.js';
import {uploadFileViaFileChooser} from './PuppeteerDriver.js';

declare global {
  interface Window {
    __cdmWdioEls?: Element[];
  }
}

const DEFAULT_PAGE_LOAD_TIMEOUT = 10_000;

/** Maps Puppeteer KeyInput names to WebDriver key names where they differ. */
const WDIO_KEY_MAP = new Map<string, string>([
  ['ArrowLeft', 'Arrow Left'],
  ['ArrowRight', 'Arrow Right'],
  ['ArrowUp', 'Arrow Up'],
  ['ArrowDown', 'Arrow Down'],
  ['PageUp', 'Page Up'],
  ['PageDown', 'Page Down'],
  ['ShiftLeft', 'Shift'],
  ['ShiftRight', 'Shift'],
  ['ControlLeft', 'Control'],
  ['ControlRight', 'Control'],
  ['AltLeft', 'Alt'],
  ['AltRight', 'Alt'],
  ['MetaLeft', 'Meta'],
  ['MetaRight', 'Meta'],
  ['NumpadEnter', 'Enter'],
  [' ', 'Space'],
]);

function toWdioKey(key: KeyInput): string {
  return WDIO_KEY_MAP.get(key) ?? key;
}

function isWdioSession(value: unknown): value is WdioSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    'switchToWindow' in value &&
    'deleteSession' in value
  );
}

function isSessionDeadError(error: unknown): boolean {
  return (
    error instanceof Error &&
    /invalid session id|session (deleted|not started)|no such session|not connected/i.test(
      error.message,
    )
  );
}

export async function createWdioSession(
  browser: Browser,
): Promise<WdioSession> {
  const wsEndpoint = browser.wsEndpoint();
  if (!wsEndpoint) {
    throw new Error(
      'The browser has no TCP debugging endpoint, so WebdriverIO cannot attach. ' +
        'Restart the server with --automation-driver wdio, or connect to a ' +
        'running Chrome with --browser-url.',
    );
  }
  let remote: (options: {
    capabilities: Record<string, unknown>;
    logLevel: 'silent';
  }) => Promise<unknown>;
  try {
    const wdio = await import('webdriverio');
    remote = wdio.remote;
  } catch (error) {
    throw new Error(
      'WDIO mode requires the optional dependency "webdriverio". Install it ' +
        'with `npm install webdriverio` in the chrome-devtools-mcp package, ' +
        'then retry.',
      {cause: error},
    );
  }
  const url = new URL(wsEndpoint);
  const session = await remote({
    capabilities: {
      browserName: 'chrome',
      'goog:chromeOptions': {
        debuggerAddress: `${url.hostname}:${url.port}`,
      },
      unhandledPromptBehavior: 'ignore',
    },
    logLevel: 'silent',
  });
  if (!isWdioSession(session)) {
    throw new Error('WebdriverIO returned an unexpected session object.');
  }
  return session;
}

export class WdioDriver implements AutomationDriver {
  readonly name = 'wdio';

  #browser: Browser;
  #sessionFactory: (browser: Browser) => Promise<WdioSession>;
  #session?: WdioSession;
  #targetIds = new WeakMap<Page, string>();

  constructor(
    browser: Browser,
    sessionFactory: (
      browser: Browser,
    ) => Promise<WdioSession> = createWdioSession,
  ) {
    this.#browser = browser;
    this.#sessionFactory = sessionFactory;
  }

  async ensureSession(): Promise<WdioSession> {
    if (!this.#session) {
      this.#session = await this.#sessionFactory(this.#browser);
    }
    return this.#session;
  }

  /** Runs an action; if the WDIO session died, re-attaches once and retries. */
  async #run<T>(action: (session: WdioSession) => Promise<T>): Promise<T> {
    const session = await this.ensureSession();
    try {
      return await action(session);
    } catch (error) {
      if (!isSessionDeadError(error)) {
        throw error;
      }
      logger('WDIO session died, re-attaching once', error);
      this.#session = undefined;
      const fresh = await this.ensureSession();
      return await action(fresh);
    }
  }

  async #getTargetId(page: ContextPage): Promise<string> {
    const cached = this.#targetIds.get(page.pptrPage);
    if (cached) {
      return cached;
    }
    const cdp = await page.pptrPage.createCDPSession();
    try {
      const {targetInfo} = await cdp.send('Target.getTargetInfo');
      this.#targetIds.set(page.pptrPage, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await cdp.detach().catch(error => {
        logger('Failed to detach CDP session', error);
      });
    }
  }

  async #switchToPage(session: WdioSession, page: ContextPage): Promise<void> {
    const targetId = await this.#getTargetId(page);
    try {
      await session.switchToWindow(`CDwindow-${targetId}`);
      return;
    } catch (error) {
      logger('Direct window handle switch failed, matching by URL', error);
    }
    for (const handle of await session.getWindowHandles()) {
      await session.switchToWindow(handle);
      if ((await session.getUrl()) === page.pptrPage.url()) {
        return;
      }
    }
    throw new Error(
      'Could not find a WebdriverIO window matching the selected page.',
    );
  }

  async #withElements<T>(
    page: ContextPage,
    handles: Array<ElementHandle<Element>>,
    action: (session: WdioSession, elements: WdioElement[]) => Promise<T>,
  ): Promise<T> {
    return await this.#run(async session => {
      await this.#switchToPage(session, page);
      if (handles.length === 1) {
        await page.pptrPage.evaluate(element => {
          window.__cdmWdioEls = [element];
        }, handles[0]);
      } else {
        await page.pptrPage.evaluate(
          (first, second) => {
            window.__cdmWdioEls = [first, second];
          },
          handles[0],
          handles[1],
        );
      }
      try {
        const elements: WdioElement[] = [];
        elements.push(await session.$(() => window.__cdmWdioEls?.[0]));
        if (handles.length > 1) {
          elements.push(await session.$(() => window.__cdmWdioEls?.[1]));
        }
        return await action(session, elements);
      } finally {
        await page.pptrPage
          .evaluate(() => {
            delete window.__cdmWdioEls;
          })
          .catch(error => {
            logger('Failed to clean up WDIO element stash', error);
          });
      }
    });
  }

  async navigate(
    page: ContextPage,
    url: string,
    options?: NavigateOptions,
  ): Promise<void> {
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      await session.setTimeout({
        pageLoad: options?.timeout ?? DEFAULT_PAGE_LOAD_TIMEOUT,
      });
      await session.url(url);
    });
  }

  async goBack(page: ContextPage, options?: NavigateOptions): Promise<void> {
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      await session.setTimeout({
        pageLoad: options?.timeout ?? DEFAULT_PAGE_LOAD_TIMEOUT,
      });
      await session.back();
    });
  }

  async goForward(page: ContextPage, options?: NavigateOptions): Promise<void> {
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      await session.setTimeout({
        pageLoad: options?.timeout ?? DEFAULT_PAGE_LOAD_TIMEOUT,
      });
      await session.forward();
    });
  }

  async reload(page: ContextPage, options?: ReloadOptions): Promise<void> {
    if (options?.ignoreCache) {
      // WebDriver has no cache-bypassing reload; use the CDP path for this
      // Chrome-specific option.
      await page.pptrPage.reload({
        timeout: options?.timeout,
        ignoreCache: true,
      });
      return;
    }
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      await session.setTimeout({
        pageLoad: options?.timeout ?? DEFAULT_PAGE_LOAD_TIMEOUT,
      });
      await session.refresh();
    });
  }

  async click(
    page: ContextPage,
    handle: ElementHandle<Element>,
    options?: ClickOptions,
  ): Promise<void> {
    await this.#withElements(page, [handle], async (_session, [element]) => {
      if (options?.dblClick) {
        await element.doubleClick();
      } else {
        await element.click();
      }
    });
  }

  async clickAt(
    page: ContextPage,
    x: number,
    y: number,
    options?: ClickOptions,
  ): Promise<void> {
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      let action = session
        .action('pointer', {parameters: {pointerType: 'mouse'}})
        .move({x: Math.round(x), y: Math.round(y)})
        .down()
        .up();
      if (options?.dblClick) {
        action = action.pause(50).down().up();
      }
      await action.perform();
    });
  }

  async hover(
    page: ContextPage,
    handle: ElementHandle<Element>,
  ): Promise<void> {
    await this.#withElements(page, [handle], async (_session, [element]) => {
      await element.moveTo();
    });
  }

  async fill(
    page: ContextPage,
    handle: ElementHandle<Element>,
    value: string,
    _options?: FillOptions,
  ): Promise<void> {
    await this.#withElements(page, [handle], async (_session, [element]) => {
      await element.setValue(value);
    });
  }

  async selectOption(
    page: ContextPage,
    handle: ElementHandle<Element>,
    value: string,
  ): Promise<void> {
    await this.#withElements(page, [handle], async (_session, [element]) => {
      await element.selectByAttribute('value', value);
    });
  }

  async drag(
    page: ContextPage,
    from: ElementHandle<Element>,
    to: ElementHandle<Element>,
  ): Promise<void> {
    await this.#withElements(
      page,
      [from, to],
      async (_session, [fromElement, toElement]) => {
        await fromElement.dragAndDrop(toElement);
      },
    );
  }

  async typeText(
    page: ContextPage,
    text: string,
    submitKey?: KeyInput,
  ): Promise<void> {
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      // Spread into characters so text that happens to equal a WebDriver key
      // name (e.g. "Enter") is typed, not pressed.
      await session.keys([...text]);
      if (submitKey) {
        await session.keys(toWdioKey(submitKey));
      }
    });
  }

  async pressKey(
    page: ContextPage,
    key: KeyInput,
    modifiers: KeyInput[],
  ): Promise<void> {
    await this.#run(async session => {
      await this.#switchToPage(session, page);
      await session.keys([
        ...modifiers.map(modifier => toWdioKey(modifier)),
        toWdioKey(key),
      ]);
    });
  }

  async uploadFile(
    page: ContextPage,
    handle: ElementHandle<Element>,
    filePath: string,
  ): Promise<void> {
    try {
      await this.#withElements(page, [handle], async (_session, [element]) => {
        await element.addValue(filePath);
      });
    } catch {
      await uploadFileViaFileChooser(page, handle, filePath);
    }
  }

  async dispose(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (session) {
      await session.deleteSession().catch(error => {
        logger('Failed to delete WDIO session', error);
      });
    }
  }
}
```

Implementation notes for the engineer:

- `import('webdriverio')` requires the package to be installed for typechecking (it is, via Task 6's optionalDependencies — if building this task before Task 6, run `npm install --save-optional webdriverio@^9` first; that is fine, Task 6 just verifies it).
- If `wdio.remote`'s return type is not structurally assignable in a way that trips the compiler, the `isWdioSession` type predicate is the sanctioned no-`as` conversion point — widen the predicate's checks rather than casting.
- `Target.getTargetInfo` without arguments describes the session's own target; puppeteer's CDP types cover it.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test tests/drivers/WdioDriver.test.ts`
Expected: PASS (7 tests). The last test passes because the harness browser uses a pipe transport.

- [ ] **Step 5: Commit**

```bash
git add src/drivers/WdioDriver.ts tests/drivers/WdioDriver.test.ts package.json package-lock.json
git commit -m "feat: add WdioDriver attaching WebdriverIO to the shared Chrome"
```

---

### Task 3: McpContext driver state + Context interface

**Files:**

- Modify: `src/McpContext.ts` (options interface ~line 48, fields ~line 90, constructor ~line 94, `dispose()` ~line 131)
- Modify: `src/tools/ToolDefinition.ts` (the `Context` type, ~line 172)
- Test: `tests/McpContext.test.ts` (append a new `describe` block)

**Interfaces:**

- Consumes: `PuppeteerDriver`, `WdioDriver`, `AutomationDriver`, `AutomationDriverName` from Tasks 1–2.
- Produces (used by Tasks 4–6):
  - `Context.getAutomationDriver(): AutomationDriver`
  - `Context.getAutomationDriverName(): AutomationDriverName`
  - `Context.selectAutomationDriver(name: AutomationDriverName): Promise<void>`
  - `McpContextOptions.automationDriver?: AutomationDriverName`

- [ ] **Step 1: Write the failing test**

Append to `tests/McpContext.test.ts` (match its existing import style; add `withMcpContext` import if not present — it is already used there):

```ts
describe('automation driver', () => {
  it('defaults to puppeteer', async () => {
    await withMcpContext(async (_response, context) => {
      assert.strictEqual(context.getAutomationDriverName(), 'puppeteer');
      assert.strictEqual(context.getAutomationDriver().name, 'puppeteer');
    });
  });

  it('selecting puppeteer is a no-op', async () => {
    await withMcpContext(async (_response, context) => {
      await context.selectAutomationDriver('puppeteer');
      assert.strictEqual(context.getAutomationDriverName(), 'puppeteer');
    });
  });

  it('selecting wdio on a pipe-connected browser fails with guidance', async () => {
    await withMcpContext(async (_response, context) => {
      await assert.rejects(
        context.selectAutomationDriver('wdio'),
        /no TCP debugging endpoint/,
      );
      // The failed switch must not change the active driver.
      assert.strictEqual(context.getAutomationDriverName(), 'puppeteer');
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test tests/McpContext.test.ts`
Expected: FAIL — `getAutomationDriverName` is not a function (build error).

- [ ] **Step 3: Implement**

In `src/tools/ToolDefinition.ts`, add to the `Context` type (imports: `import type {AutomationDriver, AutomationDriverName} from '../drivers/AutomationDriver.js';`):

```ts
getAutomationDriver(): AutomationDriver;
getAutomationDriverName(): AutomationDriverName;
selectAutomationDriver(name: AutomationDriverName): Promise<void>;
```

In `src/McpContext.ts`:

```ts
// imports
import type {AutomationDriver, AutomationDriverName} from './drivers/AutomationDriver.js';
import {PuppeteerDriver} from './drivers/PuppeteerDriver.js';
import {WdioDriver} from './drivers/WdioDriver.js';

// McpContextOptions gains:
//   automationDriver?: AutomationDriverName;

// fields
#automationDriverName: AutomationDriverName = 'puppeteer';
#puppeteerDriver = new PuppeteerDriver();
#wdioDriver?: WdioDriver;

// in the constructor, after this.#options = options;
this.#automationDriverName = options.automationDriver ?? 'puppeteer';

// methods
getAutomationDriver(): AutomationDriver {
  if (this.#automationDriverName === 'wdio') {
    return this.#getWdioDriver();
  }
  return this.#puppeteerDriver;
}

getAutomationDriverName(): AutomationDriverName {
  return this.#automationDriverName;
}

async selectAutomationDriver(name: AutomationDriverName): Promise<void> {
  if (name === 'wdio') {
    // Attach eagerly so configuration problems surface at switch time
    // instead of on the first action.
    await this.#getWdioDriver().ensureSession();
  }
  this.#automationDriverName = name;
}

#getWdioDriver(): WdioDriver {
  if (!this.#wdioDriver) {
    this.#wdioDriver = new WdioDriver(this.browser);
  }
  return this.#wdioDriver;
}
```

In `dispose()` add:

```ts
void this.#wdioDriver?.dispose();
this.#wdioDriver = undefined;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test tests/McpContext.test.ts`
Expected: PASS, including all pre-existing tests in the file.

- [ ] **Step 5: Commit**

```bash
git add src/McpContext.ts src/tools/ToolDefinition.ts tests/McpContext.test.ts
git commit -m "feat: expose automation driver selection on McpContext"
```

---

### Task 4: Route input tools through the driver

**Files:**

- Modify: `src/tools/input.ts` (every Puppeteer action call site: lines ~61-83 click, ~100-116 clickAt, ~133-149 hover, ~156-218 selectOption/fillFormElement, ~264-278 typeText, ~292-312 drag, ~368-400 uploadFile, ~417-439 pressKey)
- Test: existing `tests/tools/input.test.ts` (must pass unchanged — that is the acceptance criterion)

**Interfaces:**

- Consumes: `context.getAutomationDriver()` from Task 3.
- Produces: no new interfaces. All response strings stay identical.

- [ ] **Step 1: Rewrite handlers to delegate to the driver**

Exact changes (response lines, error handling, and `waitForEventsAfterAction` wrapping stay as-is):

- `click` handler — signature gains `context`:

```ts
handler: async (request, response, context) => {
  const uid = request.params.uid;
  const handle = await request.page.getElementByUid(uid);
  const driver = context.getAutomationDriver();
  try {
    await request.page.waitForEventsAfterAction(async () => {
      await driver.click(request.page, handle, {
        dblClick: request.params.dblClick,
      });
    });
    // ... existing response lines unchanged
```

- `clickAt`:

```ts
handler: async (request, response, context) => {
  const page = request.page;
  const driver = context.getAutomationDriver();
  await page.waitForEventsAfterAction(async () => {
    await driver.clickAt(page, request.params.x, request.params.y, {
      dblClick: request.params.dblClick,
    });
  });
```

- `hover`: `await driver.hover(request.page, handle);` inside the existing wrapper.

- `selectOption(handle, aXNode, value)` becomes `selectOption(driver, page, handle, aXNode, value)` and its inner fill call becomes:

```ts
await driver.selectOption(page, handle, childValue.toString());
```

- `fillFormElement(uid, value, context, page)` keeps its signature; inside it:

```ts
const driver = context.getAutomationDriver();
// combobox branch:
await selectOption(driver, page, handle, aXNode, value);
// default branch (timeout math unchanged):
const timeoutPerChar = 10; // ms
const fillTimeout =
  page.pptrPage.getDefaultTimeout() + value.length * timeoutPerChar;
await driver.fill(page, handle, value, {timeout: fillTimeout});
```

- `typeText` — the existing `as KeyInput` cast stays at this call site (moved expression, not a new cast):

```ts
handler: async (request, response, context) => {
  const page = request.page;
  const driver = context.getAutomationDriver();
  await page.waitForEventsAfterAction(async () => {
    await driver.typeText(
      page,
      request.params.text,
      request.params.submitKey as KeyInput | undefined,
    );
  });
```

- `drag`: `await driver.drag(request.page, fromHandle, toHandle);` (the 50ms pause now lives in PuppeteerDriver).

- `uploadFile` — the whole try/uploadFile/catch/fileChooser block collapses to:

```ts
handler: async (request, response, context) => {
  const {uid, filePath} = request.params;
  const handle = await request.page.getElementByUid(uid);
  const driver = context.getAutomationDriver();
  try {
    await driver.uploadFile(request.page, handle, filePath);
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
    response.appendResponseLine(`File uploaded from ${filePath}.`);
  } finally {
    void handle.dispose();
  }
},
```

The `ElementHandle<HTMLInputElement>` cast at the old call site is deleted (PuppeteerDriver uses `toElement('input')`).

- `pressKey`:

```ts
handler: async (request, response, context) => {
  const page = request.page;
  const tokens = parseKey(request.params.key);
  const [key, ...modifiers] = tokens;
  const driver = context.getAutomationDriver();
  await page.waitForEventsAfterAction(async () => {
    await driver.pressKey(page, key, modifiers);
  });
```

Remove now-unused imports (`ElementHandle` may still be needed for `selectOption`'s signature; keep only what compiles).

- [ ] **Step 2: Run the input tests unchanged**

Run: `npm run test tests/tools/input.test.ts`
Expected: PASS with zero modifications to the test file. If a test fails, the routing changed behavior — fix the driver, not the test.

- [ ] **Step 3: Commit**

```bash
git add src/tools/input.ts
git commit -m "refactor: route input tools through the automation driver"
```

---

### Task 5: Route navigation tools through the driver

**Files:**

- Modify: `src/tools/pages.ts` (`new_page` handler ~line 188-206, `navigate_page` handler ~line 254-374)
- Test: existing `tests/tools/pages.test.ts` and `tests/tools/pagesNavigateAllowlist.test.ts` (must pass unchanged)

**Interfaces:**

- Consumes: `context.getAutomationDriver()` from Task 3.
- Produces: none. `src/tools/performance.ts`'s `goto('about:blank')`/trace-reload calls are intentionally NOT routed (they are part of trace recording, a diagnostic flow).

- [ ] **Step 1: Route `new_page`'s initial load**

Page creation stays on `context.newPage(...)` (collector wiring). Only the load goes through the driver:

```ts
handler: async (request, response, context) => {
  const page = await context.newPage(
    request.params.background,
    request.params.isolatedContext,
  );
  const driver = context.getAutomationDriver();
  await navigateWithInterception(
    page,
    () =>
      driver.navigate(page, request.params.url, {
        timeout: request.params.timeout,
      }),
    request.params.allowList,
    request.params.timeout,
  );
  // ... unchanged
```

- [ ] **Step 2: Route `navigate_page`**

Handler signature gains `context`: `handler: async (request, response, context) => {`. Add `const driver = context.getAutomationDriver();` before `navigateWithInterception` and replace the four cases (all response strings and try/catch shapes unchanged):

- `case 'url'`: `await driver.navigate(page, request.params.url, options);`
- `case 'back'`: `await driver.goBack(page, options);`
- `case 'forward'`: `await driver.goForward(page, options);`
- `case 'reload'`: `await driver.reload(page, {...options, ignoreCache: request.params.ignoreCache});`

`initScript` (`evaluateOnNewDocument`), the beforeunload dialog handler, and `navigateWithInterception`'s CDP request interception all stay exactly as they are — they are CDP concerns that work regardless of which client navigates.

- [ ] **Step 3: Run the page tests unchanged**

Run: `npm run test tests/tools/pages.test.ts` then `npm run test tests/tools/pagesNavigateAllowlist.test.ts`
Expected: PASS with zero test modifications.

- [ ] **Step 4: Commit**

```bash
git add src/tools/pages.ts
git commit -m "refactor: route navigation tools through the automation driver"
```

---

### Task 6: CLI flag, launch transport, select_automation_driver tool

**Files:**

- Modify: `src/bin/chrome-devtools-mcp-cli-options.ts` (add option after `autoConnect`, ~line 23)
- Modify: `src/browser.ts` (`McpLaunchOptions` + `launch()` `pipe:` at line 225)
- Modify: `src/index.ts` (`getContext()` ~lines 69-113)
- Create: `src/tools/automation.ts`
- Modify: `src/tools/tools.ts` (import + spread)
- Test: `tests/index.test.ts` snapshot (regenerated), new assertions not required
- Generated: `docs/tool-reference.md`, README flag docs, telemetry metrics files

**Interfaces:**

- Consumes: `Context.selectAutomationDriver` / `getAutomationDriverName` (Task 3), `McpContextOptions.automationDriver` (Task 3).
- Produces: CLI arg `serverArgs.automationDriver: 'puppeteer' | 'wdio'`; tool `select_automation_driver`; `McpLaunchOptions.useWebSocketTransport?: boolean`.

- [ ] **Step 1: Add the CLI option**

In `cliOptions` (keep alphabetical-ish placement near the top, after `autoConnect`):

```ts
automationDriver: {
  type: 'string',
  description:
    'Automation driver used for user-visible actions (click, fill, navigate, keys). ' +
    '"wdio" routes actions through WebdriverIO attached to the same Chrome and ' +
    'requires the optional "webdriverio" dependency; Chrome is then launched with ' +
    'a WebSocket debugging transport. Diagnostics always use Chrome DevTools Protocol.',
  choices: ['puppeteer', 'wdio'] as const,
  default: 'puppeteer',
},
```

Note: `as const` in this file is the established pattern (see `channel`); it is a const assertion, not a type cast, and does not violate the repo rules.

- [ ] **Step 2: Launch with a TCP-capable transport in WDIO mode**

`src/browser.ts`:

- Add to `McpLaunchOptions`: `useWebSocketTransport?: boolean;`
- Change line 225 `pipe: true,` → `pipe: !options.useWebSocketTransport,`

`src/index.ts`, in the `ensureBrowserLaunched({...})` call, add:

```ts
useWebSocketTransport: serverArgs.automationDriver === 'wdio',
```

and in `McpContext.from(browser, logger, {...})` add:

```ts
automationDriver:
  serverArgs.automationDriver === 'wdio' ? 'wdio' : 'puppeteer',
```

(The conditional keeps the type narrow without a cast; yargs types the option as `string`.)

- [ ] **Step 3: Add the tool**

`src/tools/automation.ts`:

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';

import {ToolCategory} from './categories.js';
import {defineTool} from './ToolDefinition.js';

export const selectAutomationDriver = defineTool({
  name: 'select_automation_driver',
  description: `Selects the automation driver used for user-visible actions (click, fill, navigate, keys). "puppeteer" (default) performs actions via Puppeteer. "wdio" performs actions via WebdriverIO attached to the same browser; it requires the optional "webdriverio" dependency and a browser with a TCP debugging endpoint (start the server with --automation-driver wdio or --browser-url). Diagnostics such as traces, network, console and screenshots always use Chrome DevTools Protocol.`,
  annotations: {
    title: 'Select automation driver',
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    driver: zod
      .enum(['puppeteer', 'wdio'])
      .describe('The automation driver to use for subsequent actions.'),
  },
  handler: async (request, response, context) => {
    await context.selectAutomationDriver(request.params.driver);
    response.appendResponseLine(
      `Automation driver set to ${request.params.driver}.`,
    );
  },
});
```

`src/tools/tools.ts`: add `import * as automationTools from './automation.js';` and `...Object.values(automationTools),` to the non-slim list (alphabetically first in the spread list, before `consoleTools`).

- [ ] **Step 4: Build and regenerate**

Run in order:

1. `npm run build` — expect clean compile.
2. `npm run test tests/index.test.ts` — if the tool-list snapshot fails, run `npm run test:update-snapshots`, then inspect the snapshot diff: it must only add `select_automation_driver`.
3. `npm run docs:generate` and `npm run cli:generate` — regenerates `docs/tool-reference.md` / CLI docs with the new tool + flag.
4. `npm run update-tool-call-metrics` and `npm run update-flag-usage-metrics` — telemetry enums pick up the new tool/flag.
5. `npm run format`.

- [ ] **Step 5: Run the full suite**

Run: `npm run test`
Expected: PASS. Pay attention to `tests/browser.test.ts` (launch changes) and snapshot tests.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add --automation-driver flag and select_automation_driver tool"
```

---

### Task 7: Optional dependency, gated e2e smoke test, README

**Files:**

- Modify: `package.json` (+ `package-lock.json`)
- Create: `tests/e2e/wdio-driver.e2e.ts` (naming: check `tests/e2e/` for the local convention and match it)
- Modify: `README.md` (new "WebdriverIO mode" section after the browser-connection docs)

**Interfaces:**

- Consumes: everything above.
- Produces: shippable feature.

- [ ] **Step 1: Add the optional dependency**

Run: `npm install --save-optional webdriverio@^9`
Verify `package.json` gains `"optionalDependencies": {"webdriverio": "^9.x.x"}` and the build still passes: `npm run build`.

- [ ] **Step 2: Write the gated e2e smoke test**

`tests/e2e/wdio-driver.e2e.ts` — only runs with `TEST_WDIO=1` (it downloads chromedriver on first run):

```ts
/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import logger from 'debug';
import puppeteer, {Locator} from 'puppeteer';

import {McpContext} from '../../src/McpContext.js';
import {TextSnapshot} from '../../src/TextSnapshot.js';

const enabled = process.env['TEST_WDIO'] === '1';

describe('wdio driver e2e', {skip: !enabled}, () => {
  it('navigates, clicks and fills through a real WDIO session', async () => {
    const browser = await puppeteer.launch({
      headless: true,
      pipe: false,
      defaultViewport: null,
    });
    try {
      const context = await McpContext.from(
        browser,
        logger('test'),
        {
          experimentalDevToolsDebugging: false,
          performanceCrux: false,
          automationDriver: 'wdio',
        },
        Locator,
      );
      const driver = context.getAutomationDriver();
      assert.strictEqual(driver.name, 'wdio');
      const mcpPage = context.getSelectedMcpPage();
      await driver.navigate(
        mcpPage,
        `data:text/html,<button onclick="this.innerText='clicked'">go</button><input>`,
      );
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const button = await mcpPage.getElementByUid('1_1');
      await driver.click(mcpPage, button);
      assert.ok(await mcpPage.pptrPage.$('text/clicked'));
      const input = await mcpPage.getElementByUid('1_2');
      await driver.fill(mcpPage, input, 'hello');
      const value = await mcpPage.pptrPage.$eval('input', el => el.value);
      assert.strictEqual(value, 'hello');
      context.dispose();
    } finally {
      await browser.close();
    }
  });
});
```

Adjust uids after seeing the actual snapshot output (run once with a `console.log(mcpPage.textSnapshot)` if `1_1`/`1_2` don't match; the snapshot uid scheme is `<loaderId-counter>_<n>`).

- [ ] **Step 3: Run the e2e test**

Run: `TEST_WDIO=1 npm run test tests/e2e/wdio-driver.e2e.ts`
Expected: PASS (first run downloads chromedriver; needs network).
Also run without the env var: `npm run test tests/e2e/wdio-driver.e2e.ts` — expected: SKIPPED.

- [ ] **Step 4: README section**

Add after the "connecting to a running Chrome instance" docs:

```markdown
## WebdriverIO mode

By default all actions are performed with Puppeteer. To route user-visible
actions (click, fill, navigate, keyboard) through
[WebdriverIO](https://webdriver.io) instead, start the server with:

\`\`\`json
"args": ["-y", "chrome-devtools-mcp@latest", "--automation-driver", "wdio"]
\`\`\`

Requirements and behavior:

- The optional `webdriverio` dependency must be installed.
- WebdriverIO attaches to the same Chrome instance the server controls, so
  all diagnostics (traces, network, console, screenshots) keep working and
  always use the Chrome DevTools Protocol.
- Chrome is launched with a WebSocket debugging transport in this mode. When
  connecting to a running Chrome via `--browser-url`, `--ws-endpoint`, or
  `--auto-connect`, WDIO mode can also be enabled at runtime.
- The `select_automation_driver` tool switches between `puppeteer` and
  `wdio` at runtime.
```

- [ ] **Step 5: Full verification**

1. `npm run build`
2. `npm run test` — full suite green.
3. `npm run format` — no lint errors.
4. Manual smoke (optional but recommended): `node build/src/bin/chrome-devtools-mcp.js --automation-driver wdio` and drive `new_page` + `click` through an MCP client.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: webdriverio optional dependency, e2e smoke test and docs"
```

---

## Self-review checklist (run after writing code, before final commit)

- Spec coverage: activation (flag ✓ Task 6, runtime tool ✓ Task 6), driver seam (✓ Tasks 1-3), element bridge (✓ Task 2), tab targeting (✓ Task 2), transport caveat (✓ Task 6 Step 2), optional dep + lazy import (✓ Tasks 2/7), error handling (✓ Task 2: dead-session retry, no-endpoint error, missing-dep error), hybrid fallbacks (uploadFile chooser, ignoreCache reload ✓ Task 2), tests incl. gated e2e (✓ Tasks 1-7).
- Existing suites (`input`, `pages`, `McpContext`, `index` snapshots) pass unchanged except the tool-list snapshot gaining one entry.
- No new `as` casts / `any` / `!` outside the sanctioned patterns noted inline.
