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

declare global {
  interface Window {
    pressed?: string[];
  }
}

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

  it('types text and presses keys with modifiers', async () => {
    await withMcpContext(async (_response, context) => {
      const page = context.getSelectedPptrPage();
      await page.setContent(
        html`<input
          type="text"
          onkeydown="(window.pressed ??= []).push(event.key + ':' + event.ctrlKey)"
        />`,
      );
      await page.focus('input');
      const mcpPage = context.getSelectedMcpPage();
      const driver = new PuppeteerDriver();
      await driver.typeText(mcpPage, 'abc');
      const value = await page.$eval('input', input => input.value);
      assert.strictEqual(value, 'abc');
      await driver.pressKey(mcpPage, 'a', ['Control']);
      const pressed = await page.evaluate(() => {
        return window.pressed ?? [];
      });
      assert.ok(pressed.includes('a:true'));
    });
  });
});
