import { useState, useEffect, useCallback } from 'react';
import './index.css';

// In dev mode Vite proxies /__smartproxy_api → localhost:9091 (see vite.config.js)
const API_URL = '/__smartproxy_api/devices';

function App() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);

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

  const [teamLogoutUrl, setTeamLogoutUrl] = useState(null);

  useEffect(() => {
    fetchDevices();
    fetch('/__smartproxy_api/auth')
      .then(res => res.json())
      .then(data => {
        if (data && data.teamLogoutUrl) {
          setTeamLogoutUrl(data.teamLogoutUrl);
        }
      })
      .catch(() => {});
  }, [fetchDevices]);

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

  const showToast = (message) => {
    setToast(message);
    setTimeout(() => setToast(null), 3000);
  };

  const handleClearCookies = async (dev) => {
    try {
      const res = await fetch(`${API_URL}/${dev.id}/clear-cookies`, { method: 'POST' });
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      showToast('Куки устройства очищены 🍪');
    } catch (err) {
      setError(err.message);
    }
  };

  const handleClearLocalStorage = () => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
      showToast('Хранилище браузера очищено 🧹');
    } catch (err) {
      setError('Не удалось очистить хранилище: ' + err.message);
    }
  };


  const handleLogout = async () => {
    setLoggingOut(true);
    let logoutData = null;
    try {
      const res = await fetch('/__smartproxy_api/logout', { method: 'POST' });
      if (res.ok) {
        logoutData = await res.json().catch(() => null);
      }
    } catch (err) {
      console.error('Logout error:', err);
    }

    try {
      const cookies = document.cookie.split(';');
      for (const cookie of cookies) {
        const eqPos = cookie.indexOf('=');
        const cookieName = eqPos > -1 ? cookie.substring(0, eqPos).trim() : cookie.trim();
        if (cookieName) {
          document.cookie = `${cookieName}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
          document.cookie = `${cookieName}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${window.location.hostname}`;
        }
      }
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch (err) {
      console.error('Storage clear error:', err);
    }

    try {
      await fetch('/cdn-cgi/access/logout', { method: 'GET', credentials: 'include' }).catch(() => {});
    } catch (_) {}

    const resolvedTeamLogout = logoutData?.teamLogoutUrl || teamLogoutUrl;
    const returnTarget = encodeURIComponent(window.location.origin || '/');

    if (resolvedTeamLogout) {
      window.location.href = `${resolvedTeamLogout}?returnTo=${returnTarget}`;
    } else {
      window.location.href = `/cdn-cgi/access/logout?returnTo=${returnTarget}`;
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

  // ─── Drag & Drop ──────────────────────────────────────────────────────────
  const [draggedId, setDraggedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const handleDragStart = (e, id) => {
    setDraggedId(id);
    e.dataTransfer.effectAllowed = 'move';
    // Use a tiny timeout to allow the browser to capture the ghost image before applying styles
    setTimeout(() => {
      const el = document.getElementById(`card-${id}`);
      if (el) el.classList.add('dragging');
    }, 0);
  };

  const handleDragEnd = (e, id) => {
    setDraggedId(null);
    setDragOverId(null);
    const el = document.getElementById(`card-${id}`);
    if (el) el.classList.remove('dragging');
  };

  const handleDragOver = (e, id) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (id !== dragOverId) {
      setDragOverId(id);
    }
  };

  const handleDragLeave = (e, id) => {
    if (dragOverId === id) {
      setDragOverId(null);
    }
  };

  const handleDrop = async (e, targetId) => {
    e.preventDefault();
    setDragOverId(null);
    if (!draggedId || draggedId === targetId) return;

    const oldIndex = devices.findIndex(d => d.id === draggedId);
    const newIndex = devices.findIndex(d => d.id === targetId);
    if (oldIndex === -1 || newIndex === -1) return;

    const newDevices = [...devices];
    const [movedItem] = newDevices.splice(oldIndex, 1);
    newDevices.splice(newIndex, 0, movedItem);

    setDevices(newDevices);

    try {
      const res = await fetch(`${API_URL}/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDevices.map(d => d.id)),
      });
      if (!res.ok) throw new Error('Failed to save order');
    } catch (err) {
      setError(err.message);
      fetchDevices(); // revert on error
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="dashboard">
      <div className="dashboard-top-bar">
        <button
          type="button"
          onClick={handleLogout}
          className="btn-logout"
          disabled={loggingOut}
          title="Выйти из аккаунта (удалить токен авторизации Cloudflare Access)"
        >
          {loggingOut ? (
            <span className="spinner small" />
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
          )}
          <span>{loggingOut ? 'Выход…' : 'Выход'}</span>
        </button>
      </div>

      <header>
        <h1>Smart Proxy</h1>
        <button 
          type="button" 
          onClick={handleClearLocalStorage} 
          className="btn-clear-storage"
          title="Очистить локальное хранилище браузера"
        >
          🧹 Очистить хранилище
        </button>
      </header>

      {error && (
        <div className="error-banner" role="alert">
          ⚠️ {error}
          <button className="error-close" onClick={() => setError(null)} aria-label="Закрыть">✕</button>
        </div>
      )}

      {toast && (
        <div className="toast-notification" role="alert">
          {toast}
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
              <div 
                id={`card-${dev.id}`}
                key={dev.id} 
                className={`card ${dragOverId === dev.id ? 'drag-over' : ''}`}
                draggable
                onDragStart={(e) => handleDragStart(e, dev.id)}
                onDragEnd={(e) => handleDragEnd(e, dev.id)}
                onDragOver={(e) => handleDragOver(e, dev.id)}
                onDragLeave={(e) => handleDragLeave(e, dev.id)}
                onDrop={(e) => handleDrop(e, dev.id)}
              >
                <div className="card-header">
                  <h3 title="Зажмите и потяните для изменения порядка" className="drag-handle">{dev.name}</h3>
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
                  <button onClick={() => handleClearCookies(dev)} className="btn-clear" title="Очистить куки этого устройства">Сброс куки</button>
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