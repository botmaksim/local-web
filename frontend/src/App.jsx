import { useState, useEffect, useCallback, useRef } from 'react';
import './index.css';

// In dev mode Vite proxies /__smartproxy_api → localhost:9091 (see vite.config.js)
const API_URL = '/__smartproxy_api/devices';

function App() {
  const [devices, setDevices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [initialLoad, setInitialLoad] = useState(true);

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

  useEffect(() => {
    if (!loading) {
      const t = setTimeout(() => setInitialLoad(false), 800);
      return () => clearTimeout(t);
    }
  }, [loading]);

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

  // ─── Drag & Drop (Pointer & Touch Friendly) ──────────────────────────────
  const [draggedId, setDraggedId] = useState(null);
  const [hoverIndex, setHoverIndex] = useState(null);
  const [dragTranslate, setDragTranslate] = useState({ x: 0, y: 0 });
  const [isDropping, setIsDropping] = useState(false);

  const cardRefs = useRef(new Map());
  const dragRef = useRef({
    isDragging: false,
    pointerId: null,
    startX: 0,
    startY: 0,
    cardId: null,
    dragIndex: null,
    slotRects: [],
  });

  const hoverIndexRef = useRef(null);
  hoverIndexRef.current = hoverIndex;

  const devicesRef = useRef(devices);
  devicesRef.current = devices;

  const handlePointerDown = (e, id, index) => {
    // Only primary mouse button or touch
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (e.target.closest('button, a, input, select')) return;

    // Snapshot bounding rectangles for all card slots in the grid
    const rects = devicesRef.current.map(d => {
      const el = cardRefs.current.get(d.id);
      if (!el) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
      const r = el.getBoundingClientRect();
      return {
        id: d.id,
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom,
      };
    });

    dragRef.current = {
      isDragging: false,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      cardId: id,
      dragIndex: index,
      slotRects: rects,
    };

    const handlePointerMove = (moveEvent) => {
      if (moveEvent.pointerId !== dragRef.current.pointerId) return;

      const deltaX = moveEvent.clientX - dragRef.current.startX;
      const deltaY = moveEvent.clientY - dragRef.current.startY;

      // Require threshold to distinguish intent from tap
      if (!dragRef.current.isDragging) {
        if (Math.hypot(deltaX, deltaY) < 6) return;
        dragRef.current.isDragging = true;
        setDraggedId(dragRef.current.cardId);
        setHoverIndex(dragRef.current.dragIndex);
      }

      setDragTranslate({ x: deltaX, y: deltaY });

      const { slotRects, dragIndex } = dragRef.current;
      if (!slotRects || slotRects.length === 0) return;

      let closestIdx = dragIndex;
      let minDistance = Infinity;

      for (let i = 0; i < slotRects.length; i++) {
        const r = slotRects[i];
        if (
          moveEvent.clientX >= r.left &&
          moveEvent.clientX <= r.right &&
          moveEvent.clientY >= r.top &&
          moveEvent.clientY <= r.bottom
        ) {
          closestIdx = i;
          break;
        }
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const dist = Math.hypot(moveEvent.clientX - cx, moveEvent.clientY - cy);
        if (dist < minDistance) {
          minDistance = dist;
          closestIdx = i;
        }
      }

      setHoverIndex(closestIdx);
    };

    const handlePointerUp = (upEvent) => {
      if (upEvent.pointerId !== dragRef.current.pointerId) return;

      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);

      const wasDragging = dragRef.current.isDragging;
      const fromIdx = dragRef.current.dragIndex;
      const toIdx = hoverIndexRef.current;
      
      dragRef.current.pointerId = null;

      if (wasDragging && fromIdx !== null) {
        setIsDropping(true);
        const finalIdx = toIdx !== null ? toIdx : fromIdx;
        const fromRect = dragRef.current.slotRects[fromIdx];
        const toRect = dragRef.current.slotRects[finalIdx];
        
        if (fromRect && toRect) {
          const targetX = toRect.left - fromRect.left;
          const targetY = toRect.top - fromRect.top;
          setDragTranslate({ x: targetX, y: targetY });
        }
        
        setTimeout(() => {
          if (toIdx !== null && fromIdx !== toIdx) {
            const currentList = [...devicesRef.current];
            const [movedItem] = currentList.splice(fromIdx, 1);
            currentList.splice(toIdx, 0, movedItem);

            setDevices(currentList);

            fetch(`${API_URL}/reorder`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(currentList.map(d => d.id)),
            }).catch(err => {
              setError('Failed to save order: ' + err.message);
            });
          }

          dragRef.current = {
            isDragging: false,
            pointerId: null,
            startX: 0,
            startY: 0,
            cardId: null,
            dragIndex: null,
            slotRects: [],
          };
          setDraggedId(null);
          setHoverIndex(null);
          setDragTranslate({ x: 0, y: 0 });
          setIsDropping(false);
        }, 250);
      } else {
        dragRef.current = {
          isDragging: false,
          pointerId: null,
          startX: 0,
          startY: 0,
          cardId: null,
          dragIndex: null,
          slotRects: [],
        };
        setDraggedId(null);
        setHoverIndex(null);
        setDragTranslate({ x: 0, y: 0 });
      }
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
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
          {devices.map((dev, index) => {
            const targetUrl = `/${dev.ip}/`;
            const isBeingDragged = draggedId === dev.id;

            let cardStyle = {};
            if (isBeingDragged) {
              cardStyle = {
                transform: `translate3d(${dragTranslate.x}px, ${dragTranslate.y}px, 0) scale(${isDropping ? 1 : 1.03})`,
                zIndex: 100,
                opacity: 1,
                boxShadow: isDropping ? '0 8px 32px var(--shadow-color)' : '0 24px 50px rgba(0, 0, 0, 0.85), 0 0 30px rgba(170, 59, 255, 0.45)',
                borderColor: isDropping ? 'var(--card-border)' : 'var(--accent)',
                backgroundColor: isDropping ? 'var(--card-bg)' : 'var(--card-bg-solid)',
                transition: isDropping ? 'all 0.25s cubic-bezier(0.2, 0, 0, 1)' : 'none',
                pointerEvents: 'none',
              };
            } else if (draggedId && hoverIndex !== null && dragRef.current.dragIndex !== null) {
              const dragIdx = dragRef.current.dragIndex;
              const targetHover = hoverIndex;
              let targetSlot = index;

              if (targetHover > dragIdx && index > dragIdx && index <= targetHover) {
                targetSlot = index - 1;
              } else if (targetHover < dragIdx && index >= targetHover && index < dragIdx) {
                targetSlot = index + 1;
              }

              const { slotRects } = dragRef.current;
              if (slotRects && slotRects[index] && slotRects[targetSlot]) {
                const currentRect = slotRects[index];
                const targetRect = slotRects[targetSlot];
                const dx = targetRect.left - currentRect.left;
                const dy = targetRect.top - currentRect.top;
                if (dx !== 0 || dy !== 0) {
                  cardStyle = {
                    transform: `translate3d(${dx}px, ${dy}px, 0)`,
                    transition: 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)',
                  };
                } else {
                  cardStyle = {
                    transition: 'transform 0.25s cubic-bezier(0.2, 0, 0, 1)',
                  };
                }
              }
            }

            if (editingId === dev.id) {
              return (
                <div 
                  key={dev.id} 
                  ref={el => { if (el) cardRefs.current.set(dev.id, el); else cardRefs.current.delete(dev.id); }}
                  className={`card edit-mode ${initialLoad ? 'animate-in' : ''}`}
                >
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
                ref={el => { if (el) cardRefs.current.set(dev.id, el); else cardRefs.current.delete(dev.id); }}
                className={`card ${isBeingDragged && !isDropping ? 'dragging' : ''} ${isDropping && isBeingDragged ? 'dropping' : ''} ${initialLoad ? 'animate-in' : ''}`}
                style={cardStyle}
              >
                <div 
                  className="card-header drag-handle"
                  onPointerDown={(e) => handlePointerDown(e, dev.id, index)}
                  title="Потяните для изменения порядка"
                >
                  <div className="card-title-group">
                    <span className="drag-grip" aria-hidden="true">⠿</span>
                    <h3>{dev.name}</h3>
                  </div>
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