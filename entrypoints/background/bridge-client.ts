/**
 * 桌面端桥接 WebSocket 客户端管理器
 *
 * 支持连接到多个 CebianDesktop 桌面端实例。每个桌面端一个独立的 BridgeClient。
 *
 * 协议：JSON-RPC 2.0 over WebSocket
 *  - 连接后立即发送 session/register（含丰富浏览器信息）
 *  - 接收 tools/call 请求并执行
 *  - 发送 tools/call 响应
 *  - 自动重连（指数退避）
 *  - 连接列表可从设置中配置（名称 + IP:端口 URL）
 */

import {
  bridgeConfig,
  bridgeConnectionStatus,
  bridgeSessionId,
  type DesktopConnection,
  type BridgeConnectionStatusData,
} from '@/lib/persistence/storage';
import { runBridgeAgentTask, type AgentProgress } from './bridge-agent';

/// 重连间隔（毫秒）
const RECONNECT_BASE_MS = 2000;
const RECONNECT_MAX_MS = 30_000;

/// 生成 UUID v4
function uuidV4(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/// 获取浏览器类型
function detectBrowserType(): string {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('edg/') || ua.includes('edgios')) return 'edge';
  if (ua.includes('chrome') || ua.includes('crios')) return 'chrome';
  if (ua.includes('firefox') || ua.includes('fxios')) return 'firefox';
  if (ua.includes('safari')) return 'safari';
  if (ua.includes('opr/') || ua.includes('opera')) return 'opera';
  return 'unknown';
}

/// 获取浏览器版本
/// 优先使用 User-Agent Client Hints API 获取完整版本号（解决 Chrome UA 版本号简写问题）
/// 回退到 User-Agent 字符串解析
async function detectBrowserVersion(): Promise<string> {
  // 使用 UA Client Hints 获取完整版本（Chrome 90+ / Edge 90+）
  try {
    const nav = navigator as any;
    if (nav.userAgentData?.getHighEntropyValues) {
      const hints = await nav.userAgentData.getHighEntropyValues(['fullVersionList']);
      if (hints.fullVersionList?.length > 0) {
        // 取第一个有版本号的 brand（通常即浏览器本身）
        for (const brand of hints.fullVersionList) {
          if (brand.version) return brand.version;
        }
      }
    }
  } catch { /* UA Client Hints 不可用，回退到 User-Agent */ }

  // 回退：从 User-Agent 字符串解析
  const ua = navigator.userAgent;
  const edgMatch = ua.match(/Edg\/([\d.]+)/);
  if (edgMatch) return edgMatch[1];
  const chromeMatch = ua.match(/Chrome\/([\d.]+)/);
  if (chromeMatch) return chromeMatch[1];
  const ffMatch = ua.match(/Firefox\/([\d.]+)/);
  if (ffMatch) return ffMatch[1];
  return '';
}

/// 获取窗口数量
async function getWindowCount(): Promise<number> {
  try {
    const windows = await chrome.windows.getAll();
    return windows.length;
  } catch {
    return 0;
  }
}

// ─── 单个桌面端连接 ────────────────────────────────────────

class BridgeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private destroyed = false;
  readonly name: string;
  readonly url: string;
  private sessionId: string = '';

  /** 待处理的桌面工具调用请求（id → resolver） */
  private _pendingDesktopRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: any) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(name: string, url: string) {
    this.name = name;
    this.url = url;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** 获取连接状态（用于 UI 展示） */
  getStatus(): { name: string; url: string; connected: boolean; connectedAt: number | null } {
    return {
      name: this.name,
      url: this.url,
      connected: this.connected,
      connectedAt: this.connected ? Date.now() : null,
    };
  }

  /** 调用桌面端的本地工具，返回 Promise */
    async callDesktopTool(this: BridgeClient, tool: string, args: any): Promise<any> {
    if (!this.connected) throw new Error(`[bridge:${this.name}] 未连接到桌面端，无法调用桌面工具`);

    const id = `desktop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      // 30 秒超时
      const timer = setTimeout(() => {
        this._pendingDesktopRequests.delete(id);
        reject(new Error(`桌面工具「${tool}」执行超时（30秒）`));
      }, 30_000);

      this._pendingDesktopRequests.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'desktop/execute_tool',
        params: { name: tool, arguments: args },
      }));
    });
  }

  /** 委托任务给桌面 AI（让桌面 AI 自主规划执行），返回 Promise */
  async delegateDesktopTask(task: string): Promise<string> {
    if (!this.connected) throw new Error(`[bridge:${this.name}] 未连接到桌面端，无法委托任务`);

    const id = `desktop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    return new Promise((resolve, reject) => {
      // 5 分钟超时（桌面 AI 可能执行大量工具调用）
      const timer = setTimeout(() => {
        this._pendingDesktopRequests.delete(id);
        reject(new Error(`桌面 AI 任务执行超时（5分钟）：${task.slice(0, 100)}`));
      }, 5 * 60_000);

      this._pendingDesktopRequests.set(id, { resolve, reject, timer });

      this.ws!.send(JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'desktop/delegate_task',
        params: { task },
      }));
    });
  }

  async start(): Promise<void> {
    this.destroyed = false;
    // 加载或生成 sessionId
    let sid = await bridgeSessionId.getValue();
    if (!sid) {
      sid = uuidV4();
      await bridgeSessionId.setValue(sid);
    }
    this.sessionId = sid;
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

  private async onOpen(ws: WebSocket): Promise<void> {
    console.log(`[bridge:${this.name}] 已连接到桌面端桥接服务器（${this.url}）`);
    this.reconnectAttempt = 0;

    const browserType = detectBrowserType();
    const version = await detectBrowserVersion();
    const windowCount = await getWindowCount();

    // 发送丰富注册信息
    const registerMsg: Record<string, any> = {
      jsonrpc: '2.0',
      method: 'session/register',
      params: {
        session_id: this.sessionId,
        client_name: this.name,
        browser: browserType,
        version,
        windows: windowCount,
      },
    };

    // 尝试获取浏览器画像信息（仅 Chrome 扩展 API 可用时）
    try {
      const storage = await chrome.storage.local.get(null);
      const keys = Object.keys(storage);
      // 尝试从 chrome.profile 中获取（非标准 API，仅部分浏览器支持）
      const profile = (chrome as any).runtime?.getProfileInfo;
      if (profile) {
        const info = await profile();
        if (info) {
          registerMsg.params.profile = info.name || 'Default';
          registerMsg.params.profile_avatar = info.avatar || '';
        }
      }
    } catch {
      // 忽略画像获取失败
    }

    // 如果没获取到画像信息，尝试推断
    if (!registerMsg.params.profile) {
      try {
        const windows = await chrome.windows.getAll();
        registerMsg.params.windows = windows.length;
      } catch { /* ignore */ }
    }

    ws.send(JSON.stringify(registerMsg));
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

      // ── 处理桌面工具调用的响应 ──
      if (msg.id?.startsWith('desktop_')) {
        const pending = this._pendingDesktopRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this._pendingDesktopRequests.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error.message || '桌面工具执行失败'));
          } else {
            pending.resolve(msg.result);
          }
        }
        return;
      }

      if (msg.method === 'tools/call') {
        this.handleToolCall(msg);
      } else if (msg.method === 'agent/prompt') {
        this.handleAgentPrompt(msg);
      } else if (msg.method === 'desktop/progress') {
        // 桌面 AI 进度通知 —— 转发到 sidepanel
        this.handleDesktopProgress(msg);
      } else if (msg.method === '_ping') {
        // 连通性测试 — 立即返回 pong
        this.ws!.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: 'pong' }));
      } else if (msg.id) {
        // 未知方法但有 id — 返回 method-not-found（证明浏览器是活的）
        this.ws!.send(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        }));
      }
    } catch (err) {
      console.warn(`[bridge:${this.name}] 消息解析失败:`, err);
    }
  }

  /** 处理桌面 AI 进度通知 */
  private handleDesktopProgress(msg: any): void {
    const params = msg.params ?? {};
    if (params.reset) {
      bridgeClientManager.resetDesktopProgress();
      return;
    }
    if (params.step) {
      bridgeClientManager.appendDesktopProgressStep(params.step);
    }
  }

  /** 处理桌面端 AI 的 agent/prompt 请求 —— 让浏览器 AI 自主完成任务 */
  private async handleAgentPrompt(msg: any): Promise<void> {
    const id = msg.id;
    const task = msg.params?.task ?? msg.params?.arguments?.task ?? '';
    const timeout = msg.params?.timeout ?? 300_000; // 默认 5 分钟

    if (!id) return;
    if (!task) {
      this.sendError(id, '缺少 task 参数');
      return;
    }

    console.log(`[bridge:${this.name}] 收到 AI 任务: ${task.slice(0, 100)}...`);

    try {
      // 创建进度回调：将进度推送到桌面端
      const progressCallback = (progress: AgentProgress) => {
        if (!this.connected) return;
        this.ws!.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'agent/progress',
          params: {
            request_id: id,
            task: progress.task,
            steps: progress.steps,
            status: progress.status,
          },
        }));
      };

      // 用超时控制器包装
      const result = await withTimeout(
        runBridgeAgentTask(task, progressCallback),
        timeout,
        '浏览器 AI 执行超时',
      );
      this.sendResponse(id, {
        success: true,
        result,
        task: task.slice(0, 200),
      });
      console.log(`[bridge:${this.name}] AI 任务完成`);
    } catch (err: any) {
      console.error(`[bridge:${this.name}] AI 任务失败:`, err);
      this.sendError(id, err.message ?? String(err));
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

  // ─── 浏览器工具实现 ───

  private async executeTool(name: string, args: Record<string, any>): Promise<any> {
    switch (name) {
      case 'search_web': return this.searchWeb(args.query);
      case 'read_current_page': return this.readCurrentPage();
      case 'take_screenshot': return this.takeScreenshot();
      case 'get_tab_info': return this.getTabInfo();
      case 'get_browser_state': return this.getBrowserState();
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

  /** 获取完整的浏览器状态（所有窗口的所有标签页） */
  private async getBrowserState(): Promise<any> {
    const windows = await chrome.windows.getAll({ populate: true });
    const browserType = detectBrowserType();
    const version = await detectBrowserVersion();

    const winInfo = windows.map(w => ({
      windowId: w.id,
      focused: w.focused,
      incognito: w.incognito,
      tabs: (w.tabs ?? []).map(t => ({
        tabId: t.id,
        index: t.index,
        title: t.title ?? '',
        url: t.url ?? '',
        favIconUrl: t.favIconUrl ?? '',
        active: t.active,
        status: t.status,
        pinned: t.pinned,
      })),
    }));

    // 找出当前活跃标签页
    const activeTab = await chrome.tabs.query({ active: true, currentWindow: true });
    const current = activeTab[0] ?? null;

    return {
      browser: browserType,
      version,
      windows: winInfo,
      total_tabs: winInfo.reduce((sum, w) => sum + w.tabs.length, 0),
      total_windows: windows.length,
      current_tab: current ? {
        tabId: current.id,
        title: current.title ?? '',
        url: current.url ?? '',
      } : null,
    };
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

  /** 桌面 AI 执行进度（供 sidepanel 读取） */
  private _desktopAiProgress: { steps: any[]; status: string } = { steps: [], status: 'idle' };

  /** 获取最新桌面 AI 进度 */
  getDesktopProgress(): { steps: any[]; status: string } {
    return { ...this._desktopAiProgress, steps: [...this._desktopAiProgress.steps] };
  }

  /** 追加一个桌面 AI 进度步骤 */
  appendDesktopProgressStep(step: any): void {
    this._desktopAiProgress.steps.push(step);
    this._desktopAiProgress.status = step.type === 'done' ? 'completed' : step.type === 'error' ? 'error' : 'running';
    // 通知 sidepanel（如果有监听）
    this.notifySidepanel();
  }

  /**
   * 调用桌面端本地工具。
   * 自动选择第一个已连接的桌面客户端。
   */
  async callDesktopTool(tool: string, args: any): Promise<any> {
    const client = this.clients.find(c => c.connected);
    if (!client) throw new Error(`没有已连接的桌面端，无法调用桌面工具「${tool}」`);
    return client.callDesktopTool(tool, args);
  }

  /**
   * 委托任务给桌面 AI（让桌面 AI 自主规划执行）。
   * 自动选择第一个已连接的桌面客户端。
   */
  async delegateDesktopTask(task: string): Promise<string> {
    const client = this.clients.find(c => c.connected);
    if (!client) throw new Error('没有已连接的桌面端，无法委托任务');
    return client.delegateDesktopTask(task);
  }

  /** 重置桌面 AI 进度 */
  resetDesktopProgress(): void {
    this._desktopAiProgress = { steps: [], status: 'idle' };
    this.notifySidepanel();
  }

  /** 通知 sidepanel 进度已更新 */
  private notifySidepanel(): void {
    try {
      chrome.runtime.sendMessage({
        type: 'desktop-ai-progress',
        payload: this.getDesktopProgress(),
      }).catch(() => {
        // sidepanel 未打开时忽略错误
      });
    } catch {
      // 忽略
    }
  }

  /** 启动所有已配置的桌面端连接 */
  async start(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    await this.syncClients();

    // 监听配置变化
    bridgeConfig.watch(() => {
      this.syncClients();
    });

    // 每 3 秒更新一次连接状态到 storage（供设置页展示）
    setInterval(() => this.syncStatusToStorage(), 3000);
  }

  /** 将所有客户端状态写入 storage（设置页读取） */
  private async syncStatusToStorage(): Promise<void> {
    const data: BridgeConnectionStatusData = this.clients.map(c => c.getStatus());
    await bridgeConnectionStatus.setValue(data).catch(() => {});
  }

  /** 停止所有连接 */
  destroy(): void {
    for (const c of this.clients) {
      c.destroy();
    }
    this.clients = [];
    this.initialized = false;
  }

  /** 根据配置同步客户端列表（新增/移除/更新名称） */
  private async syncClients(): Promise<void> {
    const config = await bridgeConfig.getValue();
    const connections: DesktopConnection[] = config?.desktopConnections ?? [
      { name: '默认桌面端', url: 'ws://127.0.0.1:37421/ws' },
    ];

    // 用 URL 做唯一标识
    const desiredByName = new Map(connections.map(c => [c.url, c.name]));
    const currentByUrl = new Map(this.clients.map(c => [c.url, c]));

    // 移除不再配置的连接
    for (const [url, client] of currentByUrl) {
      if (!desiredByName.has(url)) {
        client.destroy();
        this.clients.splice(this.clients.indexOf(client), 1);
      }
    }

    // 添加新配置或更新名称
    for (const conn of connections) {
      const existing = currentByUrl.get(conn.url);
      if (!existing) {
        const client = new BridgeClient(conn.name, conn.url);
        this.clients.push(client);
        client.start();
      } else if (existing.name !== conn.name) {
        // 更新名称（WebSocket 不需要重建）
        (existing as any).name = conn.name;
      }
    }

    console.log(`[bridge-manager] 当前连接: ${this.clients.length} 个桌面端`);
  }
}

/** 全局桥接客户端管理器单例 */
export const bridgeClientManager = new BridgeClientManager();

// ─── 工具函数 ─────────────────────────────────────────────

/** 带超时的 Promise 包装 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms),
    ),
  ]);
}
