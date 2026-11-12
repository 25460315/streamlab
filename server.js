require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const RTMP_PORT = Number(process.env.RTMP_PORT || 1935);
const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const MEDIA = path.join(__dirname, 'media');
const PUBLIC_HOST = process.env.PUBLIC_HOST || '';
const CATEGORIES = [
  'Videojuegos',
  'Programación',
  'Educación',
  'Música',
  'Charlas',
  'Arte',
];

fs.mkdirSync(MEDIA, { recursive: true });
db.prepare('UPDATE users SET is_live = 0').run();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const newStreamKey = () => 'sk_' + crypto.randomBytes(12).toString('hex');

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw
      .split(';')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => {
        const i = c.indexOf('=');
        return i < 0 ? [c, ''] : [c.slice(0, i), decodeURIComponent(c.slice(i + 1))];
      })
  );
}

function getUserByToken(token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.* FROM sessions s
         JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND datetime(s.created_at, '+7 days') > datetime('now')`
      )
      .get(token) || null
  );
}

function viewerCount(username) {
  const room = io.sockets.adapter.rooms.get('ch:' + username);
  return room ? room.size : 0;
}

function decorate(u) {
  if (!u) return null;
  const followers = db
    .prepare('SELECT COUNT(*) AS n FROM follows WHERE channel_id = ?')
    .get(u.id).n;
  const thumbFile = path.join(MEDIA, 'live', u.username, 'thumb.jpg');
  return {
    id: u.id,
    username: u.username,
    title: u.title,
    category: u.category,
    bio: u.bio,
    is_live: Boolean(u.is_live),
    created_at: u.created_at,
    viewers: u.is_live ? viewerCount(u.username) : 0,
    followers,
    thumb: fs.existsSync(thumbFile) ? `/media/live/${u.username}/thumb.jpg` : null,
  };
}

function listVods(username) {
  const dir = path.join(MEDIA, 'live', username);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return {
        name: f,
        url: `/media/live/${username}/${f}`,
        size_mb: Number((st.size / (1024 * 1024)).toFixed(2)),
        created_at: st.mtime.toISOString(),
        _t: st.mtimeMs,
      };
    })
    .sort((a, b) => b._t - a._t)
    .map(({ _t, ...rest }) => rest);
}

function setSessionCookie(res, token) {
  res.setHeader(
    'Set-Cookie',
    `sl_token=${token}; HttpOnly; Path=/; Max-Age=${7 * 24 * 3600}; SameSite=Lax`
  );
}

app.use(express.json());

app.use((req, _res, next) => {
  const { sl_token } = parseCookies(req);
  req.token = sl_token || null;
  req.user = getUserByToken(req.token);
  next();
});

function auth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sesión requerida' });
  next();
}

app.use(express.static(path.join(__dirname, 'public')));
app.use(
  '/vendor/hls.js',
  express.static(path.join(__dirname, 'node_modules/hls.js/dist'))
);
app.use(
  '/media',
  express.static(MEDIA, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      }
    },
  })
);

app.post('/api/register', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res
      .status(400)
      .json({ error: 'Usuario inválido (3-20 caracteres: a-z, 0-9, _)' });
  }
  if (password.length < 6) {
    return res
      .status(400)
      .json({ error: 'La contraseña debe tener al menos 6 caracteres' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return res.status(409).json({ error: 'El nombre de usuario ya está en uso' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const info = db
    .prepare(
      'INSERT INTO users (username, password_hash, stream_key) VALUES (?, ?, ?)'
    )
    .run(username, hash, newStreamKey());

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(
    token,
    info.lastInsertRowid
  );
  setSessionCookie(res, token);

  const user = db
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(info.lastInsertRowid);
  res.json({ user: decorate(user) });
});

app.post('/api/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(
    token,
    user.id
  );
  setSessionCookie(res, token);
  res.json({ user: decorate(user) });
});

app.post('/api/logout', (req, res) => {
  if (req.token) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  }
  res.setHeader('Set-Cookie', 'sl_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  res.json({ user: req.user ? decorate(req.user) : null });
});

app.get('/api/categories', (_req, res) => {
  const rows = db
    .prepare(
      'SELECT category, COUNT(*) AS live FROM users WHERE is_live = 1 GROUP BY category'
    )
    .all();
  const map = Object.fromEntries(rows.map((r) => [r.category, r.live]));
  res.json(CATEGORIES.map((name) => ({ name, live: map[name] || 0 })));
});

app.get('/api/channels', (req, res) => {
  const { category, live } = req.query;
  const clauses = [];
  const params = [];
  if (category) {
    clauses.push('category = ?');
    params.push(category);
  }
  if (live === '1') {
    clauses.push('is_live = 1');
  }
  const where = clauses.length ? 'WHERE ' + clauses.join(' AND ') : '';
  const rows = db
    .prepare(`SELECT * FROM users ${where} ORDER BY is_live DESC, id DESC`)
    .all(...params);
  res.json(rows.map(decorate).sort((a, b) => b.is_live - a.is_live || b.viewers - a.viewers));
});

app.get('/api/channels/:username', (req, res) => {
  const u = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(req.params.username.toLowerCase());
  if (!u) return res.status(404).json({ error: 'Canal no encontrado' });

  const following = req.user
    ? Boolean(
        db
          .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?')
          .get(req.user.id, u.id)
      )
    : false;

  res.json({
    ...decorate(u),
    following,
    hls: `/media/live/${u.username}/index.m3u8`,
    vods: listVods(u.username),
  });
});

app.post('/api/channels/:username/follow', auth, (req, res) => {
  const target = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(req.params.username.toLowerCase());
  if (!target) return res.status(404).json({ error: 'Canal no encontrado' });
  if (target.id === req.user.id) {
    return res.status(400).json({ error: 'No puedes seguir tu propio canal' });
  }

  const exists = db
    .prepare('SELECT 1 FROM follows WHERE follower_id = ? AND channel_id = ?')
    .get(req.user.id, target.id);

  if (exists) {
    db.prepare('DELETE FROM follows WHERE follower_id = ? AND channel_id = ?').run(
      req.user.id,
      target.id
    );
  } else {
    db.prepare('INSERT INTO follows (follower_id, channel_id) VALUES (?, ?)').run(
      req.user.id,
      target.id
    );
  }

  const followers = db
    .prepare('SELECT COUNT(*) AS n FROM follows WHERE channel_id = ?')
    .get(target.id).n;
  res.json({ following: !exists, followers });
});

app.get('/api/following', auth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT u.* FROM follows f
       JOIN users u ON u.id = f.channel_id
       WHERE f.follower_id = ?
       ORDER BY u.is_live DESC, u.username ASC`
    )
    .all(req.user.id);
  res.json(rows.map(decorate));
});

app.get('/api/dashboard', auth, (req, res) => {
  const host = PUBLIC_HOST || req.hostname;
  res.json({
    ...decorate(req.user),
    stream_key: req.user.stream_key,
    obs_key: `${req.user.username}?key=${req.user.stream_key}`,
    rtmp_url: `rtmp://${host}:1935/live`,
    vods: listVods(req.user.username),
    categories: CATEGORIES,
  });
});

app.put('/api/dashboard', auth, (req, res) => {
  const title = String(req.body?.title || '').trim() || 'Transmisión en vivo';
  const category = CATEGORIES.includes(req.body?.category)
    ? req.body.category
    : req.user.category;
  const bio = String(req.body?.bio || '').trim().slice(0, 300);

  db.prepare('UPDATE users SET title = ?, category = ?, bio = ? WHERE id = ?').run(
    title.slice(0, 100),
    category,
    bio,
    req.user.id
  );

  io.to('ch:' + req.user.username).emit('channel:update', {
    title: title.slice(0, 100),
    category,
  });

  const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  res.json(decorate(updated));
});

app.post('/api/dashboard/regenerate-key', auth, (req, res) => {
  const stream_key = newStreamKey();
  db.prepare('UPDATE users SET stream_key = ? WHERE id = ?').run(
    stream_key,
    req.user.id
  );
  res.json({
    stream_key,
    obs_key: `${req.user.username}?key=${stream_key}`,
  });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

app.get('/c/:username', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'channel.html'));
});

// PARTE 2
const { spawn } = require('node:child_process');
const NodeMediaServer = require('node-media-server');

const COLORS = [
  '#2ec4b6',
  '#ff7a59',
  '#ff3b5c',
  '#ffd166',
  '#4cc9f0',
  '#a78bfa',
  '#80ed99',
  '#f77f00',
];

function colorFor(username) {
  let h = 0;
  for (let i = 0; i < username.length; i++) {
    h = (h * 31 + username.charCodeAt(i)) >>> 0;
  }
  return COLORS[h % COLORS.length];
}

io.on('connection', (socket) => {
  const { sl_token } = parseCookies(socket.request);
  const user = getUserByToken(sl_token);

  socket.on('join', (rawChannel) => {
    const channel = String(rawChannel || '').trim().toLowerCase();
    if (!channel) return;
    if (socket.data.channel) {
      const prev = socket.data.channel;
      socket.leave('ch:' + prev);
      io.to('ch:' + prev).emit('viewers', viewerCount(prev));
    }
    socket.data.channel = channel;
    socket.join('ch:' + channel);
    io.to('ch:' + channel).emit('viewers', viewerCount(channel));
  });

  socket.on('chat', (rawText) => {
    if (!user) {
      return socket.emit('chat:error', 'Debes iniciar sesión para chatear');
    }
    const channel = socket.data.channel;
    if (!channel) return;

    const now = Date.now();
    if (now - (socket.data.lastChat || 0) < 700) {
      return socket.emit('chat:error', 'Estás enviando mensajes demasiado rápido');
    }

    const text = String(rawText || '').trim().slice(0, 300);
    if (!text) return;

    socket.data.lastChat = now;
    io.to('ch:' + channel).emit('chat', {
      user: user.username,
      text,
      color: colorFor(user.username),
      at: new Date().toISOString(),
    });
  });

  socket.on('disconnect', () => {
    const channel = socket.data.channel;
    if (channel) {
      io.to('ch:' + channel).emit('viewers', viewerCount(channel));
    }
  });
});

const recordVod = process.env.RECORD_VOD !== 'false';

const nms = new NodeMediaServer({
  logType: 1,
  rtmp: {
    port: RTMP_PORT,
    chunk_size: 60000,
    gop_cache: true,
    ping: 30,
    ping_timeout: 60,
  },
  http: {
    port: 8000,
    host: '127.0.0.1',
    mediaroot: MEDIA,
    allow_origin: '*',
  },
  trans: {
    ffmpeg: FFMPEG,
    tasks: [
      {
        app: 'live',
        vc: 'copy',
        ac: 'copy',
        hls: true,
        hlsFlags: '[hls_time=2:hls_list_size=4:hls_flags=delete_segments]',
        mp4: recordVod,
        mp4Flags: '[movflags=frag_keyframe+empty_moov]',
      },
    ],
  },
});

const thumbTimers = new Map();

function captureThumb(username) {
  const dir = path.join(MEDIA, 'live', username);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, 'thumb.jpg');
  const proc = spawn(
    FFMPEG,
    [
      '-y',
      '-i',
      `rtmp://127.0.0.1:${RTMP_PORT}/live/${username}`,
      '-frames:v',
      '1',
      '-vf',
      'scale=640:360',
      '-q:v',
      '4',
      out,
    ],
    { stdio: 'ignore' }
  );
  proc.on('error', () => {});
}

nms.on('prePublish', (id, streamPath, args) => {
  const [, appName, username] = String(streamPath || '').split('/');
  const user = username
    ? db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase())
    : null;

  if (appName !== 'live' || !user || !args || user.stream_key !== args.key) {
    const session = nms.getSession(id);
    if (session) session.reject();
  }
});

nms.on('postPublish', (_id, streamPath, args) => {
  const [, appName, rawUser] = String(streamPath || '').split('/');
  if (appName !== 'live' || !rawUser) return;
  const username = rawUser.toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !args || user.stream_key !== args.key) return;

  db.prepare('UPDATE users SET is_live = 1 WHERE id = ?').run(user.id);
  io.emit('live', { username, live: true });

  setTimeout(() => captureThumb(username), 3000);
  clearInterval(thumbTimers.get(username));
  thumbTimers.set(
    username,
    setInterval(() => captureThumb(username), 30000)
  );
});

nms.on('donePublish', (_id, streamPath) => {
  const [, appName, rawUser] = String(streamPath || '').split('/');
  if (appName !== 'live' || !rawUser) return;
  const username = rawUser.toLowerCase();

  clearInterval(thumbTimers.get(username));
  thumbTimers.delete(username);

  db.prepare('UPDATE users SET is_live = 0 WHERE username = ?').run(username);
  io.emit('live', { username, live: false });
});

db.prepare('UPDATE users SET is_live = 0').run();
nms.run();
server.listen(PORT, () => {
  console.log(`StreamLab HTTP en http://localhost:${PORT} | RTMP en puerto ${RTMP_PORT}`);
});

