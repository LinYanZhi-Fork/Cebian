/**
 * 桥接 AI Agent - 处理来自桌面端的 agent/prompt 请求
 *
 * 当桌面端 AI 调用 ask_browser_ai 工具时，浏览器端会创建一个临时的 AI Agent
 * 来智能规划并执行目标任务，而不是死板地执行单个工具调用。
 *
 * 关键设计：始终返回有意义的结构化结果，避免"空回复"导致桌面 AI 陷入盲目循环。
 */

import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createCebianAgent } from './agent';
import { sharedTools } from '@/lib/tools';
import { discoverMCPTools } from '@/lib/tools';
import {
  lastSelectedModel,
  lastSelectedThinkingLevel,
  providerCredentials,
  customProviders,
} from '@/lib/persistence/storage';
import { resolveModel } from '@/lib/providers/resolve-model';
import { Type } from 'typebox';
import { bridgeClientManager } from './bridge-client';

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
10. VFS 文件系统工具 — 保存文件等

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

// ─── 桌面工具调用 ──────────────────────────────────────────

const ExecuteDesktopToolParameters = Type.Object({
  tool: Type.String({
    description: '要调用的桌面工具名称。可用工具：read_local_file（读取文件）、list_directory（列出目录）、get_system_info（获取系统信息）',
  }),
  arguments: Type.Optional(Type.Any({
    description: '传递给桌面工具的参数，根据工具不同而不同。read_local_file 需要 { path: string }，list_directory 需要 { path: string }，get_system_info 不需要参数。',
  })),
});

const executeDesktopTool: AgentTool<typeof ExecuteDesktopToolParameters> = {
  name: 'execute_desktop_tool',
  label: 'Execute Desktop Tool',
  description:
    '调用桌面端的本地工具（如读取文件、列出目录、获取系统信息）。' +
    '当用户询问涉及桌面本地文件、系统信息等不在浏览器范围内的任务时使用。' +
    '桌面端会执行对应的工具并返回结果。注意：工具名须在白名单中（read_local_file、list_directory、get_system_info），否则会返回错误。',
  parameters: ExecuteDesktopToolParameters,

  async execute(_toolCallId, params, _signal): Promise<any> {
    const { tool, arguments: args } = params;
    if (!tool) throw new Error('缺少 tool 参数');
    const result = await bridgeClientManager.callDesktopTool(tool, args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      details: {},
    };
  },
};

/**
 * 运行桥接 AI 任务
 *
 * 创建一个临时的 AI Agent 来执行桌面端交付的高层次任务。
 * Agent 会自主使用浏览器工具来完成任务。
 *
 * @param task 桌面端 AI 交付的任务描述
 * @param onProgress 可选的进度回调——每产生一个新步骤时调用
 * @returns 任务执行结果（结构化的执行报告）
 */
export async function runBridgeAgentTask(
  task: string,
  onProgress?: (progress: AgentProgress) => void,
): Promise<string> {
  // 1. 加载模型配置
  const modelCfg = await lastSelectedModel.getValue();
  if (!modelCfg) {
    return JSON.stringify({
      success: false,
      error: '浏览器 AI 未配置模型，请在扩展设置中选择一个模型',
      task: task.slice(0, 500),
    });
  }

  const thinkingLevel = (await lastSelectedThinkingLevel.getValue()) || 'medium';
  const creds = await providerCredentials.getValue();
  const customProvs = await customProviders.getValue();

  // 2. 解析模型
  const resolved = resolveModel(modelCfg, creds, customProvs || []);
  if (!resolved) {
    return JSON.stringify({
      success: false,
      error: `模型解析失败: ${modelCfg.provider}/${modelCfg.modelId}`,
      task: task.slice(0, 500),
    });
  }

  // 3. 组装工具列表（共享工具 + 桌面工具 + MCP 工具）
  const mcpTools = await discoverMCPTools();
  const tools: AgentTool<any>[] = [...sharedTools, executeDesktopTool, ...mcpTools];

  // 4. 创建 Agent
  const agent = createCebianAgent({
    model: resolved,
    systemPrompt: BRIDGE_SYSTEM_PROMPT,
    thinkingLevel: thinkingLevel as any,
    tools,
  });

  // 5. 收集完整的执行记录
  return new Promise<string>((resolve) => {
    let currentAssistantText = '';
    const steps: AgentProgressStep[] = []; // 可选的进度追踪

    /** 添加步骤并触发进度回调 */
    function addStep(step: AgentProgressStep) {
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
            } else {
              // 没有文本回复时，根据工具调用推断
              const calledTools = toolLog.filter(l => l.startsWith('[工具]'));
              if (calledTools.length > 0) {
                reportParts.push('\n## 浏览器 AI 回复\n任务已执行完毕。浏览器 AI 调用了以下工具：\n' +
                  calledTools.map(t => `- ${t.replace('[工具] ', '')}`).join('\n'));
              } else {
                reportParts.push('\n## 浏览器 AI 回复\n浏览器 AI 已处理请求，但未生成详细回复。');
              }
            }

            resolve(reportParts.join('\n'));
            break;
          }
        }
      } catch (err) {
        console.error('[bridge-agent] 事件处理错误:', err);
      }
    });

    // 6. 启动 Agent。prompt() 自身的 reject 在这里处理
    agent.prompt(task).catch((err: any) => {
      unsubscribe();
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
      resolve(errorReport); // 用 resolve 而不是 reject，确保始终返回字符串
    });
  });
}
