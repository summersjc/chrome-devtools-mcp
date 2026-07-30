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
import type {TextSnapshot} from '../../src/TextSnapshot.js';
import {TextSnapshot as TextSnapshotClass} from '../../src/TextSnapshot.js';

// Gated: attaches a real WebdriverIO/chromedriver session, which downloads
// chromedriver on first run. Enable with TEST_WDIO=1.
const enabled = process.env['TEST_WDIO'] === '1';

function findUidByRole(snapshot: TextSnapshot, role: string): string {
  for (const [uid, node] of snapshot.idToNode) {
    if (node.role === role) {
      return uid;
    }
  }
  throw new Error(`No node with role "${role}" found in the snapshot.`);
}

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
      mcpPage.textSnapshot = await TextSnapshotClass.create(mcpPage);
      const buttonUid = findUidByRole(mcpPage.textSnapshot, 'button');
      const button = await mcpPage.getElementByUid(buttonUid);
      await driver.click(mcpPage, button);
      assert.ok(await mcpPage.pptrPage.$('text/clicked'));
      const inputUid = findUidByRole(mcpPage.textSnapshot, 'textbox');
      const input = await mcpPage.getElementByUid(inputUid);
      await driver.fill(mcpPage, input, 'hello');
      const value = await mcpPage.pptrPage.$eval('input', el => el.value);
      assert.strictEqual(value, 'hello');
      context.dispose();
    } finally {
      await browser.close();
    }
  });
});
