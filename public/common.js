const PALETTE = [
  '#2ec4b6',
  '#ff7a59',
  '#ff3b5c',
  '#ffd166',
  '#4cc9f0',
  '#a78bfa',
  '#80ed99',
  '#f77f00',
];

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function colorFor(name) {
  const s = String(name || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length];
}

function avatar(name, extraClass = '') {
  const letter = String(name || '?').charAt(0).toUpperCase();
  const color = colorFor(name);
  const cls = ('avatar ' + extraClass).trim();
  return `<span class="${cls}" style="color:${color};border-color:${color}44">${esc(letter)}</span>`;
}

async function api(url, opts = {}) {
  const options = {
    method: opts.method || 'GET',
    headers: { ...(opts.headers || {}) },
    credentials: 'same-origin',
  };
  if (opts.body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
  }
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toast(msg, isError = false) {
  let box = document.querySelector('.toast-container');
  if (!box) {
    box = document.createElement('div');
    box.className = 'toast-container';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function renderTopbar(active = '') {
  const bar = document.getElementById('topbar') || document.querySelector('.topbar');
  let user = null;
  try {
    const res = await api('/api/me');
    user = res.user;
  } catch {}
  window.currentUser = user;
  if (!bar) return user;

  bar.innerHTML = `
    <div class="topbar-left">
      <a href="/" class="logo">
        <span class="logo-dot"></span>
        Stream<span>Lab</span>
      </a>
      <a href="/" class="nav-link ${active === 'explore' ? 'active' : ''}">Explorar</a>
      ${
        user
          ? `<a href="/?tab=following" class="nav-link ${active === 'following' ? 'active' : ''}">Siguiendo</a>
             <a href="/c/${esc(user.username)}" class="nav-link ${active === 'channel' ? 'active' : ''}">Mi canal</a>`
          : ''
      }
    </div>
    <div class="topbar-right">
      ${
        user
          ? `<a href="/dashboard.html" class="btn ${active === 'dashboard' ? 'btn-primary' : ''}">Panel de control</a>
             <a href="/c/${esc(user.username)}" class="sidebar-user" title="Ver mi canal">
               ${avatar(user.username)}
               <span class="sidebar-name">${esc(user.username)}</span>
             </a>
             <button type="button" class="btn btn-sm" id="btn-logout">Salir</button>`
          : `<a href="/login.html" class="btn">Iniciar sesión</a>
             <a href="/login.html#register" class="btn btn-primary">Registrarse</a>`
      }
    </div>
  `;

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' });
      location.href = '/';
    });
  }
  return user;
}

async function renderSidebar(el) {
  const container =
    typeof el === 'string'
      ? document.querySelector(el)
      : el || document.getElementById('sidebar') || document.querySelector('.sidebar');
  if (!container) return;

  try {
    const channels = await api('/api/channels');
    if (!channels.length) {
      container.innerHTML = `
        <div class="sidebar-title">Canales</div>
        <div class="offline-tag" style="padding:8px">Aún no hay canales registrados.</div>
      `;
      return;
    }

    container.innerHTML = `
      <div class="sidebar-title">Canales recomendados</div>
      <div class="sidebar-list">
        ${channels
          .map(
            (c) => `
          <a href="/c/${esc(c.username)}" class="sidebar-item">
            <div class="sidebar-user">
              ${avatar(c.username)}
              <div class="sidebar-meta">
                <div class="sidebar-name">${esc(c.username)}</div>
                <div class="sidebar-cat">${esc(c.category)}</div>
              </div>
            </div>
            ${
              c.is_live
                ? `<span class="live-dot">${c.viewers}</span>`
                : `<span class="offline-tag">Offline</span>`
            }
          </a>`
          )
          .join('')}
      </div>
    `;
  } catch {
    container.innerHTML = '';
  }
}

function cardHTML(c) {
  const thumbImg = c.thumb
    ? `<img src="${esc(c.thumb)}?t=${Date.now()}" alt="${esc(c.username)}" loading="lazy">`
    : `<span class="card-placeholder">${esc(c.username.slice(0, 2))}</span>`;

  return `
    <a href="/c/${esc(c.username)}" class="card">
      <div class="card-thumb">
        ${thumbImg}
        ${
          c.is_live
            ? `<span class="badge badge-live">EN VIVO</span>
               <span class="card-viewers">${c.viewers} espectadores</span>`
            : `<span class="badge badge-offline">OFFLINE</span>
               <span class="card-viewers">${c.followers} seguidores</span>`
        }
      </div>
      <div class="card-body">
        ${avatar(c.username)}
        <div class="card-info">
          <div class="card-title" title="${esc(c.title)}">${esc(c.title)}</div>
          <div class="card-user">${esc(c.username)}</div>
          <span class="card-cat">${esc(c.category)}</span>
        </div>
      </div>
    </a>
  `;
}
