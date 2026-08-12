import { useState, useEffect, useCallback } from 'react';
import './index.css';

// In dev mode Vite proxies /__smartproxy_api → localhost:9091 (see vite.config.js)
const API_URL = '/__smartproxy_api/devices';

function App() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Add-form state
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [protocol, setProtocol] = useState('http');
  const [adding, setAdding] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editIp, setEditIp] = useState('');
  const [editProtocol, setEditProtocol] = useState('http');

  // ─── Fetch ───────────────────────────────────────────────────────────────
  const fetchDevices = useCallback(async () => {
    try {
      const res = await fetch(API_URL);
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      setDevices(await res.json());
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDevices(); }, [fetchDevices]);

  // ─── Add ─────────────────────────────────────────────────────────────────
  const handleAdd = async (e) => {
    e.preventDefault();
    if (!name.trim() || !ip.trim()) return;
    setAdding(true);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), ip: ip.trim(), protocol }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      setName(''); setIp(''); setProtocol('http');
      await fetchDevices();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  };

  // ─── Delete ──────────────────────────────────────────────────────────────
  const handleDelete = async (id, deviceName) => {
    if (!window.confirm(`Удалить устройство «${deviceName}»?`)) return;
    try {
      const res = await fetch(`${API_URL}/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      await fetchDevices();
    } catch (err) {
      setError(err.message);
    }
  };

  // ─── Edit ─────────────────────────────────────────────────────────────────
  const startEdit = (dev) => {
    setEditingId(dev.id);
    setEditName(dev.name);
    setEditIp(dev.ip);
    setEditProtocol(dev.protocol || 'http');
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (id) => {
    if (!editName.trim() || !editIp.trim()) return;
    try {
      const res = await fetch(`${API_URL}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), ip: editIp.trim(), protocol: editProtocol }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Server error ${res.status}`);
      }
      setEditingId(null);
      await fetchDevices();
    } catch (err) {
      setError(err.message);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="dashboard">
      <header>
        <h1>Smart Proxy</h1>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          ⚠️ {error}
          <button className="error-close" onClick={() => setError(null)} aria-label="Закрыть">✕</button>
        </div>
      )}

      {/* ── Add form ── */}
      <form className="add-form" onSubmit={handleAdd} noValidate>
        <input
          id="input-name"
          type="text"
          placeholder="Имя устройства (напр. Роутер)"
          value={name}
          onChange={e => setName(e.target.value)}
          required
          disabled={adding}
        />
        <div className="ip-row">
          <select
            id="input-protocol"
            value={protocol}
            onChange={e => setProtocol(e.target.value)}
            className="protocol-select"
            disabled={adding}
            aria-label="Протокол"
          >
            <option value="http">http</option>
            <option value="https">https</option>
          </select>
          <input
            id="input-ip"
            type="text"
            placeholder="192.168.1.1 или 192.168.1.1:8080"
            value={ip}
            onChange={e => setIp(e.target.value)}
            pattern="^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$"
            title="IPv4 адрес, порт опционален"
            required
            disabled={adding}
          />
        </div>
        <button type="submit" className="btn-add" disabled={adding}>
          {adding ? <span className="spinner" /> : 'Добавить'}
        </button>
      </form>

      {/* ── Device grid ── */}
      {loading ? (
        <div className="loading-wrapper">
          <span className="spinner large" />
        </div>
      ) : (
        <div className="grid">
          {devices.map(dev => {
            const targetUrl = `/${dev.ip}/`;

            if (editingId === dev.id) {
              return (
                <div key={dev.id} className="card edit-mode">
                  <input
                    type="text"
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    className="edit-input"
                    placeholder="Имя устройства"
                  />
                  <div className="ip-row">
                    <select
                      value={editProtocol}
                      onChange={e => setEditProtocol(e.target.value)}
                      className="protocol-select"
                      aria-label="Протокол"
                    >
                      <option value="http">http</option>
                      <option value="https">https</option>
                    </select>
                    <input
                      type="text"
                      value={editIp}
                      onChange={e => setEditIp(e.target.value)}
                      pattern="^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$"
                      className="edit-input"
                      placeholder="192.168.1.1:8080"
                    />
                  </div>
                  <div className="card-actions">
                    <button onClick={() => saveEdit(dev.id)} className="btn-open">Сохранить</button>
                    <button onClick={cancelEdit} className="btn-del">Отмена</button>
                  </div>
                </div>
              );
            }

            return (
              <div key={dev.id} className="card">
                <div className="card-header">
                  <h3>{dev.name}</h3>
                  <span className={`badge badge-${dev.protocol || 'http'}`}>
                    {dev.protocol || 'http'}
                  </span>
                </div>
                <p className="ip-text">{dev.ip}</p>
                <div className="card-actions">
                  <a href={targetUrl} target="_blank" rel="noopener noreferrer" className="btn-open">
                    Открыть
                  </a>
                  <button onClick={() => startEdit(dev)} className="btn-edit">Изменить</button>
                  <button onClick={() => handleDelete(dev.id, dev.name)} className="btn-del">Удалить</button>
                </div>
              </div>
            );
          })}

          {devices.length === 0 && (
            <p className="empty">Устройства не добавлены. Начните с добавления роутера!</p>
          )}
        </div>
      )}
    </div>
  );
}

export default App;