import React, { useEffect, useState } from 'react';

interface CacheStats {
  totalSize: number;
  messageCount: number;
  mediaCount: number;
  avatarCount: number;
  topicCount: number;
}

interface CacheSettings {
  maxCacheSize: number;
  avatarRefreshHours: number;
}

const SIZE_OPTIONS = [
  { label: 'Sem limite', value: 0 },
  { label: '100 MB', value: 100 * 1024 * 1024 },
  { label: '500 MB', value: 500 * 1024 * 1024 },
  { label: '1 GB', value: 1024 * 1024 * 1024 },
  { label: '2 GB', value: 2 * 1024 * 1024 * 1024 },
];

const AVATAR_REFRESH_OPTIONS = [
  { label: '1 hora', value: 1 },
  { label: '6 horas', value: 6 },
  { label: '24 horas', value: 24 },
  { label: '72 horas', value: 72 },
  { label: 'Nunca', value: 999999 },
];

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

interface SettingsProps {
  onClose: () => void;
}

export const Settings: React.FC<SettingsProps> = ({ onClose }) => {
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [settings, setSettings] = useState<CacheSettings>({ maxCacheSize: 0, avatarRefreshHours: 24 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsRes, settingsRes] = await Promise.all([
        window.electronAPI.getCacheStats(),
        window.electronAPI.getCacheSettings(),
      ]);
      if (statsRes.success) {
        setStats({ totalSize: statsRes.totalSize, messageCount: statsRes.messageCount, mediaCount: statsRes.mediaCount, avatarCount: statsRes.avatarCount, topicCount: statsRes.topicCount });
      }
      if (settingsRes.success) {
        setSettings({ maxCacheSize: settingsRes.maxCacheSize, avatarRefreshHours: settingsRes.avatarRefreshHours });
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await window.electronAPI.setCacheSettings(settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const handleClearCache = async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      return;
    }
    setClearing(true);
    try {
      await window.electronAPI.clearCache();
      setClearConfirm(false);
      await loadData();
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={e => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Configurações de Cache</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
            <span className="spinner" />
          </div>
        ) : (
          <div className="settings-body">
            {stats && (
              <div className="settings-section">
                <h3>Estatísticas</h3>
                <div className="settings-stats-grid">
                  <div className="settings-stat">
                    <span className="settings-stat-value">{formatBytes(stats.totalSize)}</span>
                    <span className="settings-stat-label">Espaço total</span>
                  </div>
                  <div className="settings-stat">
                    <span className="settings-stat-value">{stats.messageCount.toLocaleString()}</span>
                    <span className="settings-stat-label">Mensagens</span>
                  </div>
                  <div className="settings-stat">
                    <span className="settings-stat-value">{stats.mediaCount.toLocaleString()}</span>
                    <span className="settings-stat-label">Arquivos de mídia</span>
                  </div>
                  <div className="settings-stat">
                    <span className="settings-stat-value">{stats.avatarCount.toLocaleString()}</span>
                    <span className="settings-stat-label">Avatares</span>
                  </div>
                  <div className="settings-stat">
                    <span className="settings-stat-value">{stats.topicCount.toLocaleString()}</span>
                    <span className="settings-stat-label">Tópicos</span>
                  </div>
                </div>
              </div>
            )}

            <div className="settings-section">
              <h3>Limite de Cache</h3>
              <div className="settings-field">
                <label>Tamanho máximo</label>
                <select
                  value={settings.maxCacheSize}
                  onChange={e => setSettings(s => ({ ...s, maxCacheSize: Number(e.target.value) }))}
                >
                  {SIZE_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <p className="settings-hint">
                Quando o limite é atingido, os arquivos de mídia menos utilizados são removidos automaticamente (LRU).
              </p>
            </div>

            <div className="settings-section">
              <h3>Atualização de Avatares</h3>
              <div className="settings-field">
                <label>Intervalo de atualização</label>
                <select
                  value={settings.avatarRefreshHours}
                  onChange={e => setSettings(s => ({ ...s, avatarRefreshHours: Number(e.target.value) }))}
                >
                  {AVATAR_REFRESH_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="settings-actions">
              <button className="settings-save-btn" onClick={handleSave} disabled={saving}>
                {saved ? '✓ Salvo!' : saving ? 'Salvando...' : 'Salvar configurações'}
              </button>
              <div className="settings-clear-wrap">
                {clearConfirm && (
                  <button className="icon-btn" style={{ fontSize: 12, padding: '6px 10px' }} onClick={() => setClearConfirm(false)}>
                    Cancelar
                  </button>
                )}
                <button
                  className={`settings-clear-btn${clearConfirm ? ' confirm' : ''}`}
                  onClick={handleClearCache}
                  disabled={clearing}
                >
                  {clearing ? 'Limpando...' : clearConfirm ? '⚠️ Confirmar limpeza' : <><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ verticalAlign: 'text-bottom', marginRight: 6 }}><path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>Limpar cache</>}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
