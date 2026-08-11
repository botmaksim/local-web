import { useState, useEffect } from 'react';
import './index.css';

const API_URL = '/api/devices';

function App() {
  const [devices, setDevices] = useState([]);
  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editIp, setEditIp] = useState('');

  const fetchDevices = () => {
    const baseUrl = import.meta.env.DEV ? 'http://localhost:9091' : '';
    fetch(`${baseUrl}${API_URL}`)
      .then(res => res.json())
      .then(data => setDevices(data))
      .catch(err => console.error("Error fetching devices", err));
  };

  useEffect(() => {
    fetchDevices();
  }, []);

  const handleAdd = async (e) => {
    e.preventDefault();
    if (!name || !ip) return;

    const baseUrl = import.meta.env.DEV ? 'http://localhost:9091' : '';
    await fetch(`${baseUrl}${API_URL}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, ip })
    });

    setName('');
    setIp('');
    fetchDevices();
  };

  const handleDelete = async (id) => {
    const baseUrl = import.meta.env.DEV ? 'http://localhost:9091' : '';
    await fetch(`${baseUrl}${API_URL}/${id}`, { method: 'DELETE' });
    fetchDevices();
  };

  const startEdit = (dev) => {
    setEditingId(dev.id);
    setEditName(dev.name);
    setEditIp(dev.ip);
  };

  const saveEdit = async (id) => {
    if (!editName || !editIp) return;
    const baseUrl = import.meta.env.DEV ? 'http://localhost:9091' : '';
    await fetch(`${baseUrl}${API_URL}/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: editName, ip: editIp })
    });
    setEditingId(null);
    fetchDevices();
  };

  return (
    <div className="dashboard">
      <header>
        <h1>Smart Proxy</h1>
      </header>

      <form className="add-form" onSubmit={handleAdd}>
        <input
          type="text"
          placeholder="Имя устройства (напр. Роутер)"
          value={name}
          onChange={e => setName(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="IP адрес (192.168.1.1 или 192.168.1.1:8080)"
          value={ip}
          onChange={e => setIp(e.target.value)}
          pattern="^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$"
          title="Пожалуйста, введите корректный IPv4 адрес (порт опционален)"
          required
        />
        <button type="submit" className="btn-add">Добавить</button>
      </form>

      <div className="grid">
        {devices.map(dev => {
          // Construct the proxy URL
          const targetUrl = import.meta.env.DEV
            ? `http://localhost:9091/${dev.ip}/`
            : `/${dev.ip}/`;

          if (editingId === dev.id) {
            return (
              <div key={dev.id} className="card edit-mode">
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  className="edit-input"
                  required
                />
                <input
                  type="text"
                  value={editIp}
                  onChange={e => setEditIp(e.target.value)}
                  pattern="^(?:[0-9]{1,3}\.){3}[0-9]{1,3}(?::[0-9]{1,5})?$"
                  className="edit-input"
                  required
                />
                <div className="card-actions">
                  <button onClick={() => saveEdit(dev.id)} className="btn-open">Сохранить</button>
                  <button onClick={() => setEditingId(null)} className="btn-del">Отмена</button>
                </div>
              </div>
            );
          }

          return (
            <div key={dev.id} className="card">
              <h3>{dev.name}</h3>
              <p className="ip-text">{dev.ip}</p>
              <div className="card-actions">
                <a href={targetUrl} target="_blank" rel="noopener noreferrer" className="btn-open">Открыть</a>
                <button onClick={() => startEdit(dev)} className="btn-edit">Изменить</button>
                <button onClick={() => handleDelete(dev.id)} className="btn-del">Удалить</button>
              </div>
            </div>
          );
        })}
        {devices.length === 0 && <p className="empty">Устройства пока не добавлены. Начните с добавления роутера!</p>}
      </div>
    </div>
  );
}

export default App;