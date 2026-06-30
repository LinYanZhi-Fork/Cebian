/**
 * BridgeSection — 双 AI 桥接配置
 *
 * 配置 CebianDesktop 的连接列表（名称 + WebSocket URL）。
 * 支持添加/移除多个桌面端连接。
 */
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useStorageItem } from '@/hooks/useStorageItem';
import { bridgeConfig } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { Wifi } from 'lucide-react';

export function BridgeSection() {
  const [config, setConfig] = useStorageItem(bridgeConfig, {
    desktopConnections: [{ name: '默认桌面端', url: 'ws://127.0.0.1:37421/ws' }],
  });

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

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.bridge.title')}</h2>

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
          {connections.map((conn, i) => (
            <div key={i} className="flex items-center gap-2 p-2 rounded-md bg-background/50 border border-border">
              <div className="flex-1 min-w-0 space-y-1.5">
                <Input
                  placeholder={t('settings.bridge.namePlaceholder') || '连接名称'}
                  value={conn.name}
                  onChange={(e) => updateConn(i, 'name', e.target.value)}
                  className="w-full text-xs h-7"
                />
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
          ))}
        </div>

        <p className="text-xs text-muted-foreground italic">
          {t('settings.bridge.changedNotice') || '修改后浏览器扩展将自动重连'}
        </p>
      </div>
    </div>
  );
}
