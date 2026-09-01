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
  blockedByDialog: false,
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    await context.selectAutomationDriver(request.params.driver);
    response.appendResponseLine(
      `Automation driver set to ${request.params.driver}.`,
    );
  },
});
