import type { AgentTool } from '@earendil-works/pi-agent-core';
import { Type } from 'typebox';

const ExecuteDesktopToolParameters = Type.Object({
  tool: Type.String({
    description: '要调用的桌面工具名称。可用工具：read_local_file（读取文件）、list_directory（列出目录）、get_system_info（获取系统信息）',
  }),
  arguments: Type.Optional(Type.Any({
    description: '传递给桌面工具的参数。read_local_file 需要 { path: string }，list_directory 需要 { path: string }，get_system_info 不需要参数。',
  })),
});

export const executeDesktopTool: AgentTool<typeof ExecuteDesktopToolParameters> = {
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
    // 动态导入避免循环依赖（bridge-client ↔ bridge-agent）
    const { bridgeClientManager } = await import('../../entrypoints/background/bridge-client');
    const result = await bridgeClientManager.callDesktopTool(tool, args ?? {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      details: {},
    };
  },
};
