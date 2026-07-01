/**
 * 桥接 AI Agent - 处理来自桌面端的 agent/prompt 请求
 *
 * 当桌面端 AI 调用 ask_browser_ai 工具时，浏览器端会创建一个临时的 AI Agent
 * 来智能规划并执行目标任务，而不是死板地执行单个工具调用。
 *
 * 关键设计：始终返回有意义的结构化结果，避免"空回复"导致桌面 AI 陷入盲目循环。
 *
 * ── 会话延续（conversation_id）──
 * 每次 agent/prompt 都可携带 conversation_id。首次调用生成新 ID，后续调用
 * 复用同一 ID 则在上次消息历史基础上继续执行，实现多轮协作的上下文连续性。
 * 灵感来源：用户反馈「委托仅一次对话，若一次做不完，新开对话完全损失上下文」。
 */

import type { AgentTool, AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model, Api } from '@earendil-works/pi-ai';
import { createCebianAgent } from './agent';
import { sharedTools, discoverMCPTools, createSessionRunSkillTool } from '@/lib/tools';
import {
  lastSelectedModel,
  lastSelectedThinkingLevel,
  providerCredentials,
  customProviders,
} from '@/lib/persistence/storage';
import { resolveModel } from '@/lib/providers/resolve-model';

/// 桥接任务的系统提示词
///
/// 浏览器 AI 是"执行者"，接收桌面 AI 委派的任务并执行。
/// 必须始终返回结构化报告，让桌面 AI 清楚知道执行结果。
const BRIDGE_SYSTEM_PROMPT = `你是一个运行在浏览器扩展中的 AI 执行助手，通过"双 AI 桥接"系统为桌面端的 AI 指挥官执行浏览器操作任务。

## 你的角色

你是执行者，不是决策者。桌面端的 AI 指挥官负责规划和决策，你负责在浏览器中执行具体的操作步骤，并报告执行结果。

## 能力

你拥有完整的浏览器自动化工具链：
1. search_web — 搜索网页（打开新标签页）
2. read_current_page — 读取当前页面的文本内容
3. interact — 与页面交互（点击、选择等）
4. inspect — 审查页面元素
5. screenshot — 截取页面截图
6. execute_js — 在页面中执行 JavaScript
7. get_page_html — 获取页面 HTML 源码
8. get_tab_info — 获取当前标签页信息
9. tabTool — 管理浏览器标签页
10. VFS 文件系统工具 — 保存文件、浏览目录等

### 你的技能（Skills）

你的扩展安装了一组 Skill 技能，存储在 VFS（虚拟文件系统）的 ~/.cebian/skills/ 目录中。每个技能是一个独立文件夹，内含 SKILL.md 作为入口描述文件。

- **查看已安装的技能列表**：用 fs_list 工具列出 ~/.cebian/skills/ 目录
- **读取某个技能的详情**：用 fs_read_file 工具读取 ~/.cebian/skills/<技能名>/SKILL.md
- **执行某个技能**：用 run_skill 工具执行技能目录中的脚本

当用户问「你有哪些技能」「读读某个技能」等涉及技能的问题时，直接使用 VFS 文件系统工具浏览 ~/.cebian/skills/ 目录即可。

### 桌面工具调用

你还可以通过 \`execute_desktop_tool\` 调用桌面端的本地工具，让桌面 AI 帮你执行文件操作、目录浏览等任务：

- \`read_local_file\` — 读取桌面端的本地文件内容（需要 path 参数）
- \`list_directory\` — 列出桌面端本地目录的文件列表（需要 path 参数）
- \`get_system_info\` — 获取桌面端的系统信息（操作系统、架构、主机名、用户名）

当用户询问涉及桌面本地文件、系统信息等不在浏览器范围内的任务时，使用 \`execute_desktop_tool\` 委派给桌面端执行。

## 通信协议

桌面 AI 通过 task 参数给你指令。你的回复必须遵循以下结构化格式：

### 最终回复格式

你的最终回复（即你输出的文本内容）必须包含以下三部分：

\`\`\`
## 执行总结
用 1-2 句话概括你做了什么，结果如何。

## 执行详情
- 步骤 1: 做了什么 → 结果如何
- 步骤 2: 做了什么 → 结果如何
- ...

## 当前状态
- 当前活跃标签页: [标题] ([URL])
- 其他打开的标签页: ...
- 浏览器状态: 正常/异常描述
\`\`\`

## 核心规则

1. **先理解，再执行**：收到任务后，先拆解成清晰的步骤，然后逐步执行。

2. **每步必查**：每调完一个工具，立即检查结果。如果工具返回错误，分析原因并尝试替代方案。

3. **打页面必验证**：如果任务涉及打开页面（search_web 或 navigate_to），打开后必须用 get_tab_info 验证页面是否成功加载。

4. **完整报告**：最终回复必须包含完整的执行总结、每个步骤的详情、以及当前浏览器状态。

5. **诚实报告错误**：如果某个步骤失败了，尝试替代方案。如果所有方案都失败，在报告中如实说明："步骤 X 失败，原因是... 尝试了替代方案 Y 但仍然失败"。

6. **不要编造结果**：如果工具返回空或错误，不要假装成功。如实报告给桌面 AI，让它决定下一步。

7. **一次只做一件事**：如果一个任务包含多个步骤（如"打开 A 然后打开 B"），一次只执行一个步骤，确认结果后再执行下一步。

8. **工具失败不 panic**：如果连续 2 次尝试同一个工具都失败，停止尝试，在报告中说明失败原因，留给桌面 AI 判断。`;

// ─── 会话延续存储 ────────────────────────────────────────────
//
// 存储按 conversation_id 索引的浏览器 AI 对话消息历史，
// 使桌面 AI 的多次 ask_browser_ai 调用能在同一个浏览器 AI 会话中延续上下文。

interface ConversationState {
  messages: AgentMessage[];
  createdAt: number;
}

const _conversations = new Map<string, ConversationState>();

/** 获取当前存储的会话数量（调试/健康检查用） */
export function getConversationCount(): number {
  return _conversations.size;
}

/** 清除指定会话的上下文 */
export function clearConversation(conversationId: string): void {
  _conversations.delete(conversationId);
}

/** 清理过期会话（默认超过 30 分钟无活动的会话自动清除） */
export function cleanupOldConversations(maxAgeMs = 30 * 60 * 1000): void {
  const now = Date.now();
  for (const [id, state] of _conversations) {
    if (now - state.createdAt > maxAgeMs) {
      _conversations.delete(id);
    }
  }
}

/**
 * 桥接任务的执行过程中的一个步骤
 */
export interface AgentProgressStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  tool?: string;
  status?: string;
  timestamp: number;
}

/**
 * 桥接任务执行进度快照
 */
export interface AgentProgress {
  task: string;
  steps: AgentProgressStep[];
  status: 'running' | 'completed' | 'error';
}

/**
 * 运行桥接 AI 任务
 *
 * 创建一个临时的 AI Agent 来执行桌面端交付的高层次任务。
 * Agent 会自主使用浏览器工具来完成任务。
 *
 * 如果传入 `conversationId` 且有对应的历史消息，则 Agent 会在已有上下文
 * 基础上继续执行（消息历史作为初始 messages 传给 createCebianAgent），
 * 实现多轮协作的上下文连续性。
 *
 * @param task 桌面端 AI 交付的任务描述
 * @param onProgress 可选的进度回调——每产生一个新步骤时调用
 * @param signal 可选的取消信号 - 当桌面 AI 被用户终止时，浏览器 AI 也随之终止
 * @param conversationId 可选的会话 ID。传入已有 ID 则延续之前的对话；不传则新建会话
 * @param aiConfig 可选的桌面端 AI 配置。传此参数时浏览器 AI 使用桌面端的模型/API Key/endpoint，跳过扩展自身的配置读取
 * @returns 任务执行结果，包含报告文本和会话 ID
 */
export async function runBridgeAgentTask(
  task: string,
  onProgress?: (progress: AgentProgress) => void,
  signal?: AbortSignal,
  conversationId?: string,
  aiConfig?: { model: string; api_key: string; endpoint: string; thinking_level: string },
): Promise<{ report: string; conversationId: string }> {
  // 1. 确定模型配置：优先使用桌面端传来的 AI 配置
  let resolved: Model<Api> | null;
  let thinkingLevel: string;

  if (aiConfig?.model && aiConfig?.api_key) {
    // 使用桌面端 AI 配置（API key、endpoint、模型名），避免在扩展中重复配置
    resolved = {
      id: aiConfig.model,
      baseUrl: aiConfig.endpoint || undefined,
      headers: {
        'Authorization': `Bearer ${aiConfig.api_key}`,
      },
    } as unknown as Model<Api>;
    thinkingLevel = aiConfig.thinking_level || 'medium';

    console.log(`[bridge-agent] 使用桌面端 AI 配置: model=${aiConfig.model}, endpoint=${aiConfig.endpoint}`);
  } else {
    // 回退到扩展自身存储的配置
    const modelCfg = await lastSelectedModel.getValue();
    if (!modelCfg) {
      const report = JSON.stringify({
        success: false,
        error: '浏览器 AI 未配置模型，请在扩展设置中选择一个模型',
        task: task.slice(0, 500),
      });
      return { report, conversationId: conversationId || '' };
    }

    thinkingLevel = (await lastSelectedThinkingLevel.getValue()) || 'medium';
    const creds = await providerCredentials.getValue();
    const customProvs = await customProviders.getValue();

    resolved = resolveModel(modelCfg, creds, customProvs || []);
    if (!resolved) {
      const report = JSON.stringify({
        success: false,
        error: `模型解析失败: ${modelCfg.provider}/${modelCfg.modelId}`,
        task: task.slice(0, 500),
      });
      return { report, conversationId: conversationId || '' };
    }
  }

  // 3. 组装工具列表（共享工具 + run_skill + MCP 工具）
  const mcpTools = await discoverMCPTools();
  const sessionId = crypto.randomUUID();
  const runSkillTool = createSessionRunSkillTool(sessionId);
  const tools: AgentTool<any>[] = [runSkillTool, ...sharedTools, ...mcpTools];

  // 4. 加载已有会话消息（若 conversationId 存在），或生成新会话 ID
  let initialMessages: AgentMessage[] = [];
  const isNewConversation = !conversationId || !_conversations.has(conversationId);
  if (!isNewConversation) {
    const existing = _conversations.get(conversationId!)!;
    initialMessages = [...existing.messages];
  } else {
    conversationId = conversationId || `conv_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  }

  // 5. 创建 Agent（注入历史消息以延续上下文）
  const agent = createCebianAgent({
    model: resolved,
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    thinkingLevel: thinkingLevel as any,
    tools,
    messages: initialMessages,
  });

  // 6. 收集完整的执行记录
  return new Promise<{ report: string; conversationId: string }>((resolve) => {
    let currentAssistantText = '';
    let cancelled = false;
    const steps: AgentProgressStep[] = []; // 可选的进度追踪

    // 如果外部要求取消，立即返回取消消息
    if (signal?.aborted) {
      cancelled = true;
      resolve({ report: buildCancelledReport(task), conversationId: conversationId! });
      return;
    }
    const onAbort = () => {
      if (cancelled) return;
      cancelled = true;
      unsubscribe();
      addStep({
        type: 'error',
        content: '🛑 桌面 AI 已被用户终止，浏览器 AI 任务已取消',
        status: 'cancelled',
        timestamp: Date.now(),
      });
      onProgress?.({
        task: task.slice(0, 200),
        steps: [...steps],
        status: 'error',
      });
      resolve({ report: buildCancelledReport(task), conversationId: conversationId! });
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    /** 保存当前会话的消息历史到存储中 */
    function saveConversationMessages() {
      if (conversationId) {
        _conversations.set(conversationId, {
          messages: agent.state.messages,
          createdAt: Date.now(),
        });
      }
    }

    /** 添加步骤并触发进度回调 */
    function addStep(step: AgentProgressStep) {
      if (cancelled) return;
      steps.push(step);
      onProgress?.({
        task: task.slice(0, 200),
        steps: [...steps],
        status: 'running',
      });
    }

    const unsubscribe = agent.subscribe(async (event: any) => {
      try {
        switch (event.type) {
          case 'message_update': {
            const msg = event.message;
            if (msg?.role === 'assistant') {
              if (typeof msg.content === 'string' && msg.content.trim()) {
                currentAssistantText = msg.content;
                // 仅当内容发生变化时添加 thinking 步骤（避免重复）
                const lastStep = steps[steps.length - 1];
                if (!lastStep || lastStep.type !== 'thinking' || lastStep.content !== msg.content.slice(0, 100)) {
                  addStep({
                    type: 'thinking',
                    content: msg.content.slice(0, 500),
                    timestamp: Date.now(),
                  });
                }
              }
              // 工具调用声明
              if (msg.tool_calls?.length > 0) {
                for (const tc of msg.tool_calls) {
                  const argsStr = typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments.slice(0, 200)
                    : JSON.stringify(tc.function?.arguments ?? {}).slice(0, 200);
                  addStep({
                    type: 'tool_call',
                    content: `${tc.function?.name}(${argsStr})`,
                    tool: tc.function?.name,
                    status: 'running',
                    timestamp: Date.now(),
                  });
                }
              }
            }
            break;
          }

          case 'agent_end': {
            unsubscribe();

            // 标记完成
            addStep({
              type: 'tool_result',
              content: '✅ 浏览器 AI 任务执行完成',
              status: 'success',
              timestamp: Date.now(),
            });
            onProgress?.({
              task: task.slice(0, 200),
              steps: [...steps],
              status: 'completed',
            });

            // 保存会话消息，供后续延续使用
            saveConversationMessages();

            // 从 state.messages 构建完整执行报告
            const messages = agent.state.messages;

            // 提取最终的 AI 回复文本
            let finalAssistantText = currentAssistantText;
            for (let i = messages.length - 1; i >= 0; i--) {
              const m = messages[i] as any;
              if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
                finalAssistantText = m.content;
                break;
              }
            }

            // 提取工具调用日志
            const toolLog: string[] = [];
            for (const raw of messages) {
              const m = raw as any;
              if (m.role === 'assistant' && m.tool_calls) {
                for (const tc of m.tool_calls) {
                  const args = typeof tc.function?.arguments === 'string'
                    ? tc.function.arguments.slice(0, 300)
                    : JSON.stringify(tc.function?.arguments ?? {}).slice(0, 300);
                  toolLog.push(`[工具] ${tc.function?.name} | 参数: ${args}`);
                }
              }
              if (m.role === 'toolResult') {
                const name = m.name || 'unknown';
                const content = typeof m.content === 'string'
                  ? m.content.slice(0, 800)
                  : JSON.stringify(m.content).slice(0, 800);
                toolLog.push(`[结果] ${name}: ${content}`);
              }
            }

            // 构建结构化报告
            const reportParts: string[] = [];

            // 任务说明
            reportParts.push(`## 任务\n${task}`);

            // 执行记录
            if (toolLog.length > 0) {
              reportParts.push(`\n## 执行记录\n\`\`\`\n${toolLog.join('\n')}\n\`\`\``);
            } else {
              reportParts.push('\n## 执行记录\n（未调用任何工具）');
            }

            // AI 回复
            if (finalAssistantText?.trim()) {
              reportParts.push(`\n## 浏览器 AI 回复\n${finalAssistantText}`);
            } else if (toolLog.length > 0) {
              // 没有文本回复但调用了工具（如 fs_list / fs_read_file ）—— 将工具执行记录作为回复
              reportParts.push('\n## 浏览器 AI 回复\n任务已执行完毕。执行记录如下：\n' +
                toolLog.map(l => `- ${l}`).join('\n'));
            } else {
              reportParts.push('\n## 浏览器 AI 回复\n浏览器 AI 已处理请求，但未生成详细回复。');
            }

            resolve({ report: reportParts.join('\n'), conversationId: conversationId! });
            break;
          }
        }
      } catch (err) {
        console.error('[bridge-agent] 事件处理错误:', err);
      }
    });

    // 7. 启动 Agent。prompt() 自身的 reject 在这里处理
    agent.prompt(task).catch((err: any) => {
      unsubscribe();
      // 出错也保存消息（部分执行的内容对后续可能有参考价值）
      saveConversationMessages();
      addStep({
        type: 'error',
        content: err?.message || String(err),
        status: 'error',
        timestamp: Date.now(),
      });
      onProgress?.({
        task: task.slice(0, 200),
        steps: [...steps],
        status: 'error',
      });
      const errorReport = [
        `## 任务\n${task}`,
        `\n## 错误\n浏览器 AI 执行失败: ${err?.message || String(err)}`,
      ].join('\n');
      resolve({ report: errorReport, conversationId: conversationId! }); // 用 resolve 而不是 reject，确保始终返回字符串
    });
  });
}

/** 构建取消报告（桌面 AI 被用户终止时） */
function buildCancelledReport(task: string): string {
  return [
    `## 任务\n${task}`,
    '\n## 执行记录\n（任务已被用户取消）',
    '\n## 浏览器 AI 回复\n🛑 桌面 AI 已被用户终止，浏览器 AI 任务已取消。',
  ].join('\n');
}
