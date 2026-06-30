/**
 * 桌面端桥接 WebSocket 客户端管理器
 *
 * 支持连接到多个 CebianDesktop 桌面端实例。每个桌面端一个独立的 BridgeClient。
 *
 * 协议：JSON-RPC 2.0 over WebSocket
 *  - 连接后立即发送 session/register
 *  - 接收 tools/call 请求并执行
 *  - 发送 tools/call 响应
 *  - 自动重连（指数退避）
 *  - 连接列表可从设置中配置（名称 + IP:端口 URL）
 */

import { bridgeConfig, type DesktopConnection } from '@/lib/persistence/storage';

/// 重连间隔（毫秒）
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

// ─── 单个桌面端连接 ────────────────────────────────────────

class BridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  readonly name: string;
  readonly url: string;

  constructor(name: string, url: string) {
    this.name = name;
    this.url = url;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    this.destroyed = false;
    this.connect();
  }

  destroy(): void {
    this.destroyed = true;
    this.clearReconnect();
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.destroyed) return;

    try {
      const ws = new WebSocket(this.url);
      ws.onopen = () => this.onOpen(ws);
      ws.onclose = (ev) => this.onClose(ev);
      ws.onerror = () => this.onError(ws);
      ws.onmessage = (ev) => this.onMessage(ev);
      this.ws = ws;
    } catch (err) {
      console.warn(`[bridge:${this.name}] WebSocket 连接失败:`, err);
      this.scheduleReconnect();
    }
  }

  private onOpen(ws: WebSocket): void {
    console.log(`[bridge:${this.name}] 已连接到桌面端桥接服务器（${this.url}）`);
    this.reconnectAttempt = 0;

    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'session/register',
      params: { client_name: this.name },
    }));
  }

  private onClose(ev: CloseEvent): void {
    console.log(`[bridge:${this.name}] 连接已关闭:`, ev.code, ev.reason);
    this.ws = null;
    if (!this.destroyed) {
      this.scheduleReconnect();
    }
  }

  private onError(ws: WebSocket): void {
    console.warn(`[bridge:${this.name}] WebSocket 错误，即将重连`);
  }

  private onMessage(ev: MessageEvent): void {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.jsonrpc !== '2.0') return;
      if (msg.method === 'tools/call') {
        this.handleToolCall(msg);
      }
    } catch (err) {
      console.warn(`[bridge:${this.name}] 消息解析失败:`, err);
    }
  }

  private async handleToolCall(msg: any): Promise<void> {
    const id = msg.id;
    const toolName = msg.params?.name;
    const args = msg.params?.arguments ?? {};

    if (!id) return;

    try {
      const result = await this.executeTool(toolName, args);
      this.sendResponse(id, result);
    } catch (err: any) {
      this.sendError(id, err.message ?? String(err));
    }
  }

  private sendResponse(id: string, result: any): void {
    if (!this.connected) return;
    this.ws!.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result,
    }));
  }

  private sendError(id: string, message: string): void {
    if (!this.connected) return;
    this.ws!.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -1, message },
    }));
  }

  // ─── 8 个浏览器工具实现 ───

  private async executeTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'search_web': return this.searchWeb(args.query);
      case 'read_current_page': return this.readCurrentPage();
      case 'take_screenshot': return this.takeScreenshot();
      case 'get_tab_info': return this.getTabInfo();
      case 'execute_js': return this.executeJs(args.code);
      case 'fill_form': return this.fillForm(args.selector, args.value);
      case 'click_element': return this.clickElement(args.selector);
      case 'get_page_html': return this.getPageHtml();
      default:
        throw new Error(`未知的浏览器工具: ${name}`);
    }
  }

  private async searchWeb(query: string): Promise<any> {
    if (!query) throw new Error('缺少 query 参数');
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const tab = await chrome.tabs.create({ url: searchUrl, active: true });
    return {
      message: `已在新标签页中搜索「${query}」`,
      tabId: tab.id,
      url: searchUrl,
    };
  }

  private async readCurrentPage(): Promise<any> {
    const tabId = await this.getActiveTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const article = document.querySelector('article');
        const main = document.querySelector('main');
        const body = document.body;
        const text = (article || main || body)?.innerText ?? '';
        return { title: document.title, url: window.location.href, text: text.slice(0, 50000) };
      },
    } as any);
    const content = results?.[0]?.result;
    if (!content) throw new Error('无法读取页面内容');
    return content;
  }

  private async takeScreenshot(): Promise<any> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error('没有活跃标签页');
    const dataUrl = await chrome.tabs.captureVisibleTab(tabs[0].windowId, { format: 'png' });
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    return { data: base64, mimeType: 'image/png', size: base64.length };
  }

  private async getTabInfo(): Promise<any> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs.length === 0) throw new Error('没有活跃标签页');
    const tab = tabs[0];
    return { tabId: tab.id, windowId: tab.windowId, title: tab.title ?? '', url: tab.url ?? '', favIconUrl: tab.favIconUrl ?? '', status: tab.status, incognito: tab.incognito };
  }

  private async executeJs(code: string): Promise<any> {
    if (!code) throw new Error('缺少 code 参数');
    const tabId = await this.getActiveTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (jsCode: string) => {
        try {
          const fn = new Function(`return (async () => { ${jsCode} })()`);
          return fn();
        } catch (e: any) {
          if (/unsafe-eval|Content Security Policy/i.test(e.message)) {
            return { __csp_blocked__: true, error: e.message };
          }
          throw e;
        }
      },
      args: [code],
      world: 'MAIN',
    } as any);
    return { result: results?.[0]?.result };
  }

  private async fillForm(selector: string, value: string): Promise<any> {
    if (!selector) throw new Error('缺少 selector 参数');
    const tabId = await this.getActiveTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string, val: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`未找到元素: ${sel}`);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
          if (nativeSetter) nativeSetter.call(el, val);
          else el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.tagName === 'SELECT') {
          const select = el as HTMLSelectElement;
          const option = Array.from(select.options).find(o => o.text === val || o.value === val);
          if (option) { select.value = option.value; select.dispatchEvent(new Event('change', { bubbles: true })); }
        } else { (el as any).value = val; }
        return { success: true, selector: sel, value: val };
      },
      args: [selector, value],
      world: 'MAIN',
    } as any);
    return results?.[0]?.result ?? { success: true };
  }

  private async clickElement(selector: string): Promise<any> {
    if (!selector) throw new Error('缺少 selector 参数');
    const tabId = await this.getActiveTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el) throw new Error(`未找到元素: ${sel}`);
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, buttons: 1 }));
        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
        return { success: true, selector: sel };
      },
      args: [selector],
      world: 'MAIN',
    } as any);
    return results?.[0]?.result ?? { success: true };
  }

  private async getPageHtml(): Promise<any> {
    const tabId = await this.getActiveTabId();
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({ html: document.documentElement.outerHTML, title: document.title, url: window.location.href, length: document.documentElement.outerHTML.length }),
    } as any);
    const content = results?.[0]?.result;
    if (!content) throw new Error('无法获取页面 HTML');
    return content;
  }

  private async getActiveTabId(): Promise<number> {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) throw new Error('没有活跃标签页');
    return tab.id;
  }

  private scheduleReconnect(): void {
    this.clearReconnect();
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
    this.reconnectAttempt++;
    console.log(`[bridge:${this.name}] ${(delay / 1000).toFixed(1)} 秒后重连...`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }
}

// ─── 多客户端管理器 ─────────────────────────────────────────

class BridgeClientManager {
  private clients: BridgeClient[] = [];
  private initialized = false;

  /** 启动所有已配置的桌面端连接 */
  async start(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.syncClients();

    // 监听配置变化
    bridgeConfig.watch(() => {
      this.syncClients();
    });
  }

  /** 停止所有连接 */
  destroy(): void {
    for (const c of this.clients) {
      c.destroy();
    }
    this.clients = [];
    this.initialized = false;
  }

  /** 根据配置同步客户端列表（新增/移除） */
  private async syncClients(): Promise<void> {
    const config = await bridgeConfig.getValue();
    const connections: DesktopConnection[] = config?.desktopConnections ?? [
      { name: '默认桌面端', url: 'ws://127.0.0.1:37421/ws' },
    ];

    // 用 URL 做唯一标识来比对
    const currentUrls = new Set(this.clients.map(c => c.url));
    const desiredUrls = new Set(connections.map(c => c.url));

    // 移除不再配置的连接
    for (let i = this.clients.length - 1; i >= 0; i--) {
      if (!desiredUrls.has(this.clients[i].url)) {
        this.clients[i].destroy();
        this.clients.splice(i, 1);
      }
    }

    // 添加新配置的连接
    for (const conn of connections) {
      if (!currentUrls.has(conn.url)) {
        const client = new BridgeClient(conn.name, conn.url);
        this.clients.push(client);
        client.start();
      }
    }

    console.log(`[bridge-manager] 当前连接: ${this.clients.length} 个桌面端`);
  }
}

/** 全局桥接客户端管理器单例 */
export const bridgeClientManager = new BridgeClientManager();
