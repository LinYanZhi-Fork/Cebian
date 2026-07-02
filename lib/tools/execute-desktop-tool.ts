import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

const DelegateDesktopTaskParameters = Type.Object({
  task: Type.String({
    description: '要交给桌面 AI 执行的任务描述。不要指定具体工具——桌面 AI 会自己规划工具调用。例如："读取桌面上的 B站首页封面 文件夹的内容" 而不是 "list_directory(C:/Users/...)"',
  }),
});

export const executeDesktopTool: AgentTool<typeof DelegateDesktopTaskParameters> = {
  name: 'delegate_desktop_task',
  label: 'Delegate Desktop Task',
  description:
    '将任务委托给桌面端的 AI（Desktop AI）自主执行。' +
    '桌面端收到任务描述后会自己规划工具调用（读文件、列目录、查系统信息等），完成所有操作后返回最终结果。' +
    '当用户询问涉及桌面本地文件、目录内容、系统信息等不在浏览器范围内的任务时使用。' +
    '注意：这是"委托"而不是"直接调用"——你只需描述"做什么"，桌面 AI 自己决定"怎么做"。' +
    '例如用 delegate_desktop_task({ task: "读取桌面B站首页封面文件夹的内容" })，' +
    '而不是 execute_desktop_tool({ tool: "list_directory", arguments: {...} })。',
  parameters: DelegateDesktopTaskParameters,

  async execute(_toolCallId, params, _signal): Promise<any> {
    const { task } = params;
    if (!task) throw new Error('缺少 task 参数');
    // 动态导入避免循环依赖（bridge-client ↔ bridge-agent）
    const { bridgeClientManager } = await import('../../entrypoints/background/bridge-client');
    const result = await bridgeClientManager.delegateDesktopTask(task);
    return {
      content: [{ type: 'text', text: result }],
      details: {},
    };
  },
};
