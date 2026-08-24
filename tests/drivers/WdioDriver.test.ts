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
    async waitForEnabled(options?: {timeout?: number}) {
      calls.push({method: 'element.waitForEnabled', args: [options]});
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
    async getTitle() {
      calls.push({method: 'getTitle', args: []});
      return 'stub title';
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

  it('passes the caller-computed fill timeout to waitForEnabled', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(html`<input />`);
      const mcpPage = context.getSelectedMcpPage();
      mcpPage.textSnapshot = await TextSnapshot.create(mcpPage);
      const handle = await mcpPage.getElementByUid('1_1');
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await driver.fill(mcpPage, handle, 'hello', {timeout: 4321});
      const waitCall = calls.find(
        call => call.method === 'element.waitForEnabled',
      );
      assert.deepStrictEqual(waitCall?.args[0], {timeout: 4321});
      const setValueCall = calls.find(
        call => call.method === 'element.setValue',
      );
      assert.deepStrictEqual(setValueCall?.args, ['hello']);
    });
  });

  it('rejects elements that live inside an iframe', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(
        html`<iframe srcdoc="<button>inner</button>"></iframe>`,
      );
      const frame = page
        .frames()
        .find(candidate => candidate !== page.mainFrame());
      assert.ok(frame, 'expected an iframe to be attached');
      const handle = await frame.waitForSelector('button');
      assert.ok(handle);
      const mcpPage = context.getSelectedMcpPage();
      const calls: StubCall[] = [];
      const driver = new WdioDriver(context.browser, async () =>
        createStubSession(calls),
      );
      await assert.rejects(
        driver.click(mcpPage, handle),
        /Elements inside iframes are not supported in wdio mode/,
      );
      assert.ok(!methods(calls).includes('element.click'));
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
