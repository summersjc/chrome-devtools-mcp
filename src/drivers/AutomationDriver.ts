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
    filePaths: string[],
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
  waitForEnabled(options?: {timeout?: number}): Promise<void>;
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
  getTitle(): Promise<string>;
  setTimeout(timeouts: {pageLoad?: number}): Promise<unknown>;
  deleteSession(): Promise<unknown>;
}
