/**
 * BridgeSection — 双 AI 桥接配置与状态
 *
 * 配置 CebianDesktop 的连接列表，并实时显示每个连接的当前状态。
 */
import { CircleCheck, CircleX, Plus, Trash2, Wifi } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useStorageItem } from '@/hooks/useStorageItem';
import { bridgeConfig, bridgeConnectionStatus, type BridgeConnectionStatusData } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { useEffect, useState } from 'react';

export function BridgeSection() {
  const [config, setConfig] = useStorageItem(bridgeConfig, {
    desktopConnections: [{ name: '默认桌面端', url: 'ws://127.0.0.1:37421/ws' }],
  });
  const [connStatus, setConnStatus] = useState<BridgeConnectionStatusData>([]);

  // 监听桥接连接状态变化
  useEffect(() => {
    const unwatch = bridgeConnectionStatus.watch((data) => {
      setConnStatus(data ?? []);
    });
    // 立即读取一次
    bridgeConnectionStatus.getValue().then((v) => setConnStatus(v ?? [])).catch(() => {});
    return () => unwatch();
  }, []);

  const connections = config.desktopConnections ?? [];

  const updateConn = (index: number, field: 'name' | 'url', value: string) => {
    const updated = connections.map((c, i) =>
      i === index ? { ...c, [field]: value } : c
    );
    setConfig({ ...config, desktopConnections: updated });
  };

  const addConn = () => {
    setConfig({
      ...config,
      desktopConnections: [
        ...connections,
        { name: '', url: 'ws://127.0.0.1:37421/ws' },
      ],
    });
  };

  const removeConn = (index: number) => {
    const updated = connections.filter((_, i) => i !== index);
    setConfig({
      ...config,
      desktopConnections: updated.length > 0 ? updated : [{ name: '默认桌面端', url: 'ws://127.0.0.1:37421/ws' }],
    });
  };

  const getStatusForUrl = (url: string) => connStatus.find(s => s.url === url);

  return (
    <div className="flex-1 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.bridge.title')}</h2>

      {/* 连接状态面板 */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Wifi size={16} />
          <span>{t('settings.bridge.title')}</span>
        </div>

        {connStatus.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">暂无连接状态</p>
        ) : (
          <div className="space-y-2">
            {connStatus.map((s, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded-md bg-background/50 border border-border">
                {s.connected ? (
                  <CircleCheck size={14} className="text-green-500 shrink-0" />
                ) : (
                  <CircleX size={14} className="text-muted-foreground shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <span className="text-xs font-medium">{s.name}</span>
                  <p className="text-[0.6rem] text-muted-foreground truncate">{s.url}</p>
                </div>
                <span className={`text-[0.6rem] px-1.5 py-0.5 rounded-full ${s.connected ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'}`}>
                  {s.connected ? '已连接' : '未连接'}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 连接配置列表 */}
      <div className="rounded-lg border border-border bg-card p-4 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wifi size={16} />
            <span>Cebian ↔ CebianDesktop</span>
          </div>
          <button
            onClick={addConn}
            className="flex items-center gap-1 px-2 py-1 text-xs text-primary hover:bg-primary/10 rounded-md transition-colors"
          >
            <Plus size={12} />
            {t('settings.bridge.addConnection') || '添加连接'}
          </button>
        </div>

        <div className="space-y-3">
          {connections.map((conn, i) => {
            const stat = getStatusForUrl(conn.url);
            return (
              <div key={i} className="flex items-center gap-2 p-2 rounded-md bg-background/50 border border-border">
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder={t('settings.bridge.namePlaceholder') || '连接名称'}
                      value={conn.name}
                      onChange={(e) => updateConn(i, 'name', e.target.value)}
                      className="flex-1 text-xs h-7"
                    />
                    {stat && (
                      <span className={`text-[0.55rem] px-1.5 py-0.5 rounded-full shrink-0 ${stat.connected ? 'bg-green-500/10 text-green-600' : 'bg-muted text-muted-foreground'}`}>
                        {stat.connected ? '在线' : '离线'}
                      </span>
                    )}
                  </div>
                  <Input
                    placeholder="ws://192.168.1.100:37421/ws"
                    value={conn.url}
                    onChange={(e) => updateConn(i, 'url', e.target.value)}
                    className="w-full text-xs h-7 font-mono"
                  />
                </div>
                <button
                  onClick={() => removeConn(i)}
                  className="p-1.5 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded-md transition-colors shrink-0"
                  title={t('settings.bridge.remove') || '移除'}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>

        <p className="text-xs text-muted-foreground italic">
          修改后浏览器扩展将自动重连，无需重启
        </p>
      </div>
    </div>
  );
}
