/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../utils/logger.js';
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
  // Pin the browser version so WebdriverIO downloads a matching chromedriver
  // instead of the latest one (e.g. "HeadlessChrome/147.0.7727.57").
  const browserVersion = (await browser.version()).match(/[\d.]+$/)?.[0];
  const session = await remote({
    capabilities: {
      browserName: 'chrome',
      ...(browserVersion ? {browserVersion} : {}),
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
      logger?.('WDIO session died, re-attaching once', error);
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
        logger?.('Failed to detach CDP session', error);
      });
    }
  }

  async #switchToPage(session: WdioSession, page: ContextPage): Promise<void> {
    const targetId = await this.#getTargetId(page);
    try {
      await session.switchToWindow(`CDwindow-${targetId}`);
      return;
    } catch (error) {
      logger?.('Direct window handle switch failed, matching by URL', error);
    }
    const targetUrl = page.pptrPage.url();
    const targetTitle = await page.pptrPage.title();
    const matches: string[] = [];
    for (const handle of await session.getWindowHandles()) {
      await session.switchToWindow(handle);
      if (
        (await session.getUrl()) === targetUrl &&
        (await session.getTitle()) === targetTitle
      ) {
        matches.push(handle);
      }
    }
    if (matches.length === 1) {
      await session.switchToWindow(matches[0]);
      return;
    }
    if (matches.length > 1) {
      throw new Error(
        `Multiple WebdriverIO windows match URL "${targetUrl}" — close the ` +
          'duplicate tabs, or select the page again to refresh its handle.',
      );
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
      // The stash is written and read in the top-level browsing context, so a
      // handle from an iframe would either throw on evaluate or silently
      // resolve to the wrong node. Fail loudly instead.
      const mainFrame = page.pptrPage.mainFrame();
      for (const handle of handles) {
        if (handle.frame !== mainFrame) {
          throw new Error(
            'Elements inside iframes are not supported in wdio mode. Switch ' +
              'back to the puppeteer driver with select_automation_driver to ' +
              'interact with this element.',
          );
        }
      }
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
            logger?.('Failed to clean up WDIO element stash', error);
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
    options?: FillOptions,
  ): Promise<void> {
    await this.#withElements(page, [handle], async (_session, [element]) => {
      // Callers scale the timeout to the value length; without this the
      // WebDriver default applies and long fills time out early.
      await element.waitForEnabled(
        options?.timeout === undefined ? undefined : {timeout: options.timeout},
      );
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
    filePaths: string[],
  ): Promise<void> {
    try {
      await this.#withElements(page, [handle], async (_session, [element]) => {
        // setValue clears first, matching Puppeteer's uploadFile, which
        // replaces the selection rather than appending to it. WebDriver takes
        // multiple files as newline-separated paths on a single send-keys.
        await element.setValue(filePaths.join('\n'));
      });
    } catch {
      await uploadFileViaFileChooser(page, handle, filePaths);
    }
  }

  async dispose(): Promise<void> {
    const session = this.#session;
    this.#session = undefined;
    if (session) {
      await session.deleteSession().catch(error => {
        logger?.('Failed to delete WDIO session', error);
      });
    }
  }
}
