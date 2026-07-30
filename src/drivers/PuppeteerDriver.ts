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

  async goForward(
    page: ContextPage,
    options?: NavigateOptions,
  ): Promise<void> {
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
