import { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronRight,
  ChevronLeft,
  Brain,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
  Monitor,
  Terminal,
} from 'lucide-react';

interface ProgressStep {
  type: 'thinking' | 'tool_call' | 'tool_result' | 'done' | 'error';
  content: string;
  tool?: string | null;
  timestamp: number;
}

interface DesktopProgress {
  steps: ProgressStep[];
  status: 'idle' | 'running' | 'completed' | 'error';
}

// ─── Step Icon ────────────────────────────────────────────

function StepIcon({ type }: { type: ProgressStep['type'] }) {
  switch (type) {
    case 'thinking':
      return <Brain size={14} className="text-violet-500 shrink-0" />;
    case 'tool_call':
      return <Wrench size={14} className="text-amber-500 shrink-0" />;
    case 'tool_result':
      return <Terminal size={14} className="text-emerald-500 shrink-0" />;
    case 'done':
      return <CheckCircle2 size={14} className="text-green-500 shrink-0" />;
    case 'error':
      return <XCircle size={14} className="text-red-500 shrink-0" />;
  }
}

function StepTypeLabel({ type }: { type: ProgressStep['type'] }) {
  switch (type) {
    case 'thinking':
      return '思考';
    case 'tool_call':
      return '工具调用';
    case 'tool_result':
      return '工具结果';
    case 'done':
      return '完成';
    case 'error':
      return '错误';
  }
}

// ─── Step Item ────────────────────────────────────────────

function StepItem({ step, isLast }: { step: ProgressStep; isLast: boolean }) {
  const [open, setOpen] = useState(false);
  const isError = step.type === 'error';
  const isThinking = step.type === 'thinking';
  const hasDetails = step.content.length > 60;

  return (
    <div className="relative pl-7 pb-3">
      {!isLast && (
        <div className="absolute left-[11px] top-[18px] bottom-0 w-px bg-border" />
      )}
      <div className={`absolute left-2 top-[5px] size-[14px] rounded-full border-2 flex items-center justify-center ${
        isError
          ? 'border-red-500 bg-red-500/10'
          : 'border-border bg-background'
      }`}>
        <div className={`size-[6px] rounded-full ${
          isError ? 'bg-red-500' : 'bg-muted-foreground/30'
        }`} />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <StepIcon type={step.type} />
          <span className="text-xs font-medium text-foreground/80">
            <StepTypeLabel type={step.type} />
            {step.tool && (
              <code className="ml-1 text-[0.55rem] bg-accent/50 px-1 py-0.5 rounded font-mono">
                {step.tool}
              </code>
            )}
          </span>
          {isThinking && (
            <span className="inline-block size-2 bg-violet-500 rounded-full animate-pulse" />
          )}
        </div>
        {isThinking ? (
          <div className="text-[0.65rem] text-muted-foreground/70 mt-0.5 leading-relaxed">
            {step.content}
          </div>
        ) : (
          <>
            <div className="text-[0.65rem] text-muted-foreground/70 mt-0.5 line-clamp-1 leading-relaxed">
              {step.content.slice(0, 80)}
              {step.content.length > 80 && '...'}
            </div>
            {hasDetails && (
              <>
                <button
                  onClick={() => setOpen(!open)}
                  className="flex items-center gap-1 text-[0.55rem] text-primary/60 hover:text-primary mt-0.5"
                >
                  <ChevronRight size={10} className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                  {open ? '收起详情' : '查看详情'}
                </button>
                {open && (
                  <pre className="mt-1 p-2 rounded-md bg-muted/50 border border-border text-[0.55rem] font-mono leading-relaxed whitespace-pre-wrap break-words max-h-32 overflow-y-auto" style={{ scrollbarWidth: 'thin' }}>
                    {step.content}
                  </pre>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Desktop Monitor ──────────────────────────────────────

export function DesktopMonitor() {
  const navigate = useNavigate();
  const [progress, setProgress] = useState<DesktopProgress>({ steps: [], status: 'idle' });
  const listRef = useRef<HTMLDivElement>(null);

  // 监听来自 background 的桌面 AI 进度推送
  useEffect(() => {
    const handler = (msg: any) => {
      if (msg?.type === 'desktop-ai-progress' && msg?.payload) {
        setProgress(msg.payload);
      }
    };
    chrome.runtime.onMessage.addListener(handler);

    // 挂载时主动拉取一次最新进度
    chrome.runtime.sendMessage({ type: 'get-desktop-ai-progress' }).catch(() => {});

    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  // 自动滚动到最新步骤
  useEffect(() => {
    if (progress.status === 'running' && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [progress.steps.length, progress.status]);

  // 状态指示
  const statusInfo = (() => {
    switch (progress.status) {
      case 'running':
        return { icon: <Loader2 size={12} className="animate-spin text-primary" />, text: '桌面 AI 执行中...', className: 'text-primary' };
      case 'completed':
        return { icon: <CheckCircle2 size={12} className="text-emerald-500" />, text: '桌面 AI 已完成', className: 'text-emerald-500' };
      case 'error':
        return { icon: <XCircle size={12} className="text-red-500" />, text: '桌面 AI 执行出错', className: 'text-red-500' };
      default:
        return { icon: <Monitor size={12} className="text-muted-foreground/50" />, text: '等待桌面 AI 活动...', className: 'text-muted-foreground/60' };
    }
  })();

  return (
    <div className="flex flex-col h-full">
      {/* 状态头部 */}
      <div className="flex items-center gap-2 px-2 py-2 border-b border-border bg-card/50">
        <button
          onClick={() => navigate('/chat/new')}
          className="p-1 rounded-md hover:bg-accent text-muted-foreground hover:text-foreground transition-colors shrink-0"
          title="返回聊天"
        >
          <ChevronLeft size={14} />
        </button>
        {statusInfo.icon}
        <span className={`text-xs font-medium ${statusInfo.className}`}>{statusInfo.text}</span>
        {progress.steps.length > 0 && (
          <span className="ml-auto text-[0.55rem] text-muted-foreground/50 tabular-nums">
            {progress.steps.length} 步
          </span>
        )}
      </div>

      {/* 步骤列表 */}
      <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-2" style={{ scrollbarWidth: 'thin' }}>
        {progress.steps.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <Monitor size={24} className="text-muted-foreground/20 mb-2" />
            <p className="text-[0.65rem] text-muted-foreground/40">
              暂无桌面 AI 活动记录
            </p>
            <p className="text-[0.55rem] text-muted-foreground/30 mt-1">
              当桌面端 AI 开始执行任务时，\n执行步骤将实时显示在此处
            </p>
          </div>
        ) : (
          progress.steps.map((step, i) => (
            <StepItem
              key={i}
              step={step}
              isLast={i === progress.steps.length - 1}
            />
          ))
        )}
      </div>

      {/* 底部信息 */}
      {progress.steps.length > 0 && progress.status === 'idle' && (
        <div className="px-3 py-1.5 border-t border-border/50 text-[0.55rem] text-muted-foreground/40 text-center">
          最近更新: {new Date(progress.steps[progress.steps.length - 1].timestamp).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
