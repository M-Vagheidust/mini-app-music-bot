require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN || '8973013935:AAE9N-n3I8jKWg9TWu_wmZICZDaeD6zzFbw';
const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://mini-app-music-bot-production.up.railway.app').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '8080', 10);
const ADMIN_IDS = [849152312];
const GROUP_URL = 'https://t.me/+k1KWTCq0FMswZjM0';

const DB_FILE = path.join(__dirname, 'songs_db.json');
const USERS_DB_FILE = path.join(__dirname, 'users_db.json');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

let ALL_SONGS = [];
let USERS_DB = { users: {}, requests: [] };
let BOT_USERNAME = '';
let updatedCounter = 0;
const COVER_CACHE = new Map();

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

function normalizeText(text) {
  if (!text) return '';
  let t = String(text).toLowerCase();
  const map = {
    'ي': 'ی', 'ك': 'ک', 'آ': 'ا', 'أ': 'ا', 'إ': 'ا',
    'ۀ': 'ه', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ی',
    '\u200c': ' ', '_': ' ', '-': ' ', '.': ' ', '/': ' ', '\\': ' '
  };
  for (const [k, v] of Object.entries(map)) {
    t = t.split(k).join(v);
  }
  return t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function cleanDisplayText(text) {
  if (!text) return 'نامشخص';
  let t = String(text)
    .replace(/\.(mp3|m4a|ogg|flac|wav)+$/i, '')
    .replace(/^\s*\d+\s*[\|\s\-\.]+\d*\s*[\-\._]+\s*/, '')
    .replace(/\(\s*(320|128|160)\s*\)/g, '')
    .replace(/(@\w+|\[.*?\]|~.*)/g, '')
    .replace(/_/g, ' ')
    .replace(/^[\s\-_|/؛.]+|[\s\-_|/؛.]+$/g, '');
  return t || 'نامشخص';
}

function isPlayable(song) {
  const hasFile = Boolean(song.file_id && String(song.file_id).trim());
  const hasSrc = song.from_chat_id != null && song.message_id != null;
  return hasFile || hasSrc;
}

function loadSongs() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      ALL_SONGS = [];
      return;
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : (parsed.songs || parsed.messages || []);
    const seen = new Set();

    ALL_SONGS = items.filter(x => x && typeof x === 'object').map((item, idx) => {
      let id = parseInt(item.id, 10) || (idx + 1);
      while (seen.has(id)) id++;
      seen.add(id);

      const title = cleanDisplayText(item.title || item.name || 'نامشخص');
      const performer = cleanDisplayText(item.performer || item.artist || 'نامشخص');
      const sourceChat = item.from_chat_id ?? item.chat_id ?? null;
      const messageId = item.message_id ?? null;
      const fileId = String(item.file_id || '').trim();

      const song = {
        id,
        uid: `${id}_${messageId || idx}`,
        from_chat_id: sourceChat,
        message_id: messageId,
        file_id: fileId,
        file_unique_id: String(item.file_unique_id || '').trim(),
        title,
        performer,
        search_text: normalizeText(`${title} ${performer} ${item.search_text || ''}`),
        media_type: String(item.media_type || 'audio').toLowerCase(),
        plays: Math.max(0, parseInt(item.plays, 10) || 0),
        likes: Math.max(0, parseInt(item.likes, 10) || 0),
        available: item.available !== undefined ? Boolean(item.available) : true
      };
      if (!isPlayable(song)) song.available = false;
      return song;
    });
    console.log(`✅ دیتابیس موزیک بارگذاری شد: کل=${ALL_SONGS.length} | فعال=${getActiveSongs().length}`);
  } catch (err) {
    console.error('❌ خطا در خواندن songs_db.json:', err.message);
  }
}

function saveSongs() {
  try {
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ALL_SONGS, null, 2), 'utf8');
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {}
}

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_DB_FILE)) {
      USERS_DB = { users: {}, requests: [] };
      return;
    }
    const raw = fs.readFileSync(USERS_DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    USERS_DB = { users: data.users || {}, requests: data.requests || [] };
  } catch (err) {}
}

function saveUsers() {
  try {
    const tmp = `${USERS_DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(USERS_DB, null, 2), 'utf8');
    fs.renameSync(tmp, USERS_DB_FILE);
  } catch (err) {}
}

function getActiveSongs() {
  return ALL_SONGS.filter(s => s.available && isPlayable(s));
}

function deleteSongById(songId) {
  const idx = ALL_SONGS.findIndex(s => s.id === Number(songId));
  if (idx === -1) return null;
  const [removed] = ALL_SONGS.splice(idx, 1);
  saveSongs();
  return removed;
}

function registerUser(user) {
  if (!user || !user.id) return;
  const uid = String(user.id);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.name || '';
  if (!USERS_DB.users[uid]) {
    USERS_DB.users[uid] = {
      id: user.id,
      name: fullName,
      username: user.username || '',
      favorites: [],
      joined_at: Math.floor(Date.now() / 1000)
    };
    saveUsers();
  } else if (fullName && USERS_DB.users[uid].name !== fullName) {
    USERS_DB.users[uid].name = fullName;
    saveUsers();
  }
}

function toggleFavorite(userId, songId) {
  const uid = String(userId);
  if (!USERS_DB.users[uid]) {
    USERS_DB.users[uid] = { id: userId, name: '', username: '', favorites: [], joined_at: Math.floor(Date.now() / 1000) };
  }
  const favs = USERS_DB.users[uid].favorites;
  const song = ALL_SONGS.find(s => s.id === songId);
  const idx = favs.indexOf(songId);
  let liked = false;

  if (idx > -1) {
    favs.splice(idx, 1);
    if (song) song.likes = Math.max(0, song.likes - 1);
  } else {
    favs.push(songId);
    liked = true;
    if (song) song.likes = (song.likes || 0) + 1;
  }
  saveUsers();
  if (song) saveSongs();
  return { liked, likes: song ? song.likes : 0, favorites: favs };
}

function resolveUserId(initData, fallbackId) {
  if (initData && BOT_TOKEN) {
    try {
      const params = new URLSearchParams(initData);
      const hash = params.get('hash');
      if (hash) {
        params.delete('hash');
        const keys = Array.from(params.keys()).sort();
        const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (calcHash === hash && params.has('user')) {
          const u = JSON.parse(params.get('user'));
          if (u?.id) return u.id;
        }
      }
      if (params.has('user')) {
        const u = JSON.parse(params.get('user'));
        if (u?.id) return u.id;
      }
    } catch (e) {}
  }
  if (fallbackId && String(fallbackId).trim() !== '' && String(fallbackId) !== 'undefined') {
    return fallbackId;
  }
  return null;
}

async function resolvePlayableFile(song) {
  let lastError = 'اطلاعات فایل ناقص است';

  if (song.file_id && String(song.file_id).trim()) {
    try {
      const check = await axios.get(`${TELEGRAM_API}/getFile`, {
        params: { file_id: song.file_id },
        timeout: 10000
      });
      if (check.data?.ok && check.data?.result?.file_path) {
        return { fileId: song.file_id, filePath: check.data.result.file_path };
      }
    } catch (e) {
      lastError = e.response?.data?.description || e.message;
      if (lastError.includes('wrong file_id')) {
        song.file_id = '';
      }
    }
  }

  if (song.from_chat_id && song.message_id && ADMIN_IDS.length > 0) {
    let chatId = String(song.from_chat_id).trim();
    const candidates = [chatId];
    if (!chatId.startsWith('-100') && chatId.startsWith('-')) {
      candidates.push(`-100${chatId.slice(1)}`);
    } else if (!chatId.startsWith('-')) {
      candidates.push(`-100${chatId}`);
    }

    for (const targetChat of candidates) {
      try {
        const fwd = await axios.post(`${TELEGRAM_API}/forwardMessage`, {
          chat_id: ADMIN_IDS[0],
          from_chat_id: targetChat,
          message_id: song.message_id,
          disable_notification: true
        }, { timeout: 12000 });

        const msg = fwd.data?.result;
        const audioObj = msg?.audio || msg?.document || msg?.voice;
        if (msg?.message_id) {
          axios.post(`${TELEGRAM_API}/deleteMessage`, { chat_id: ADMIN_IDS[0], message_id: msg.message_id }).catch(() => {});
        }
        if (audioObj?.file_id) {
          song.file_id = audioObj.file_id;
          song.from_chat_id = targetChat;
          saveSongs();
          const check2 = await axios.get(`${TELEGRAM_API}/getFile`, {
            params: { file_id: song.file_id },
            timeout: 10000
          });
          if (check2.data?.ok && check2.data?.result?.file_path) {
            return { fileId: song.file_id, filePath: check2.data.result.file_path };
          }
        }
      } catch (e) {
        lastError = `(${targetChat}): ${e.response?.data?.description || e.message}`;
      }
    }
  }

  return { error: lastError };
}

loadSongs();
loadUsers();

// ---------------------------------------------------------------------------
// سرور وب Express و API های مینی‌اپ + پروفایل تلگرام + پنل ادمین
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'templates', 'index.html');
  if (fs.existsSync(htmlPath)) res.sendFile(htmlPath);
  else res.send('<h1>GapMusic Mini App Active</h1>');
});

app.get('/api/config', (req, res) => {
  const userId = resolveUserId(req.query.init_data, req.query.user_id);
  const savedUser = userId ? USERS_DB.users[String(userId)] : null;
  res.json({
    bot_username: BOT_USERNAME,
    total_songs: getActiveSongs().length,
    total_users: Object.keys(USERS_DB.users).length,
    total_requests: USERS_DB.requests.length,
    is_admin: isAdmin(userId),
    user_name: savedUser?.name || ''
  });
});

// دریافت و استریم مستقیم عکس پروفایل تلگرام کاربر برای هدر مینی‌اپ
app.get('/api/avatar/:userId', async (req, res) => {
  const uid = req.params.userId;
  if (!uid || uid === 'undefined') return res.status(404).end();

  try {
    const photosResp = await axios.get(`${TELEGRAM_API}/getUserProfilePhotos`, {
      params: { user_id: uid, limit: 1 },
      timeout: 8000
    });
    const photos = photosResp.data?.result?.photos;
    if (!photos || !photos.length || !photos[0].length) {
      return res.status(404).end();
    }
    const fileId = photos[0][0].file_id;
    const fileResp = await axios.get(`${TELEGRAM_API}/getFile`, {
      params: { file_id: fileId },
      timeout: 8000
    });
    const filePath = fileResp.data?.result?.file_path;
    if (!filePath) return res.status(404).end();

    const imgResp = await axios.get(`${TELEGRAM_FILE_API}/${filePath}`, {
      responseType: 'stream',
      timeout: 15000
    });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    imgResp.data.pipe(res);
  } catch (e) {
    res.status(404).end();
  }
});

app.get('/api/songs', (req, res) => {
  const q = normalizeText(req.query.q || '');
  const filter = req.query.filter || 'all';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));

  let songs = [...getActiveSongs()].reverse();
  if (filter === 'popular') {
    songs = [...getActiveSongs()].sort((a, b) => (b.plays - a.plays) || (b.likes - a.likes));
  }

  if (q) {
    const tokens = q.split(' ');
    const exact = songs.filter(s => tokens.every(t => s.search_text.includes(t)));
    const partial = songs.filter(s => !exact.includes(s) && tokens.some(t => s.search_text.includes(t)));
    songs = [...exact, ...partial];
  }

  const total = songs.length;
  const items = songs.slice(offset, offset + limit).map(s => ({
    uid: s.uid,
    id: s.id,
    title: s.title,
    performer: s.performer,
    likes: s.likes || 0,
    plays: s.plays || 0
  }));

  res.json({ total, offset, limit, has_more: offset + items.length < total, items });
});

app.delete('/api/admin/song/:id', (req, res) => {
  const userId = resolveUserId(req.body?.init_data || req.query.init_data, req.body?.user_id || req.query.user_id);
  if (!isAdmin(userId)) {
    return res.status(403).json({ detail: 'دسترسی غیرمجاز! فقط ادمین اجازه حذف دارد.' });
  }

  const songId = parseInt(req.params.id, 10);
  const removed = deleteSongById(songId);
  if (!removed) {
    return res.status(404).json({ detail: 'موزیک یافت نشد یا قبلاً حذف شده است.' });
  }

  res.json({
    status: 'ok',
    deleted: removed,
    remaining: getActiveSongs().length
  });
});

app.get('/api/cover', async (req, res) => {
  const title = String(req.query.title || '').trim();
  const artist = String(req.query.artist || '').trim();
  const query = `${artist !== 'نامشخص' ? artist : ''} ${title !== 'نامشخص' ? title : ''}`.trim();

  if (!query) return res.json({ artwork: null });
  if (COVER_CACHE.has(query)) return res.json({ artwork: COVER_CACHE.get(query) });

  try {
    const resp = await axios.get('https://itunes.apple.com/search', {
      params: { term: query, media: 'music', limit: 1 },
      timeout: 5000
    });
    const results = resp.data?.results || [];
    let artwork = null;
    if (results.length > 0 && results[0].artworkUrl100) {
      artwork = results[0].artworkUrl100.replace('100x100bb', '500x500bb');
    }
    COVER_CACHE.set(query, artwork);
    res.json({ artwork });
  } catch (e) {
    res.json({ artwork: null });
  }
});

app.get('/api/favorites', (req, res) => {
  const userId = resolveUserId(req.query.init_data, req.query.user_id);
  if (!userId) return res.json({ favorite_ids: [], items: [] });

  const favIds = USERS_DB.users[String(userId)]?.favorites || [];
  const activeMap = new Map(getActiveSongs().map(s => [s.id, s]));
  const items = [...favIds].reverse()
    .map(id => activeMap.get(id))
    .filter(Boolean)
    .map(s => ({
      uid: s.uid,
      id: s.id,
      title: s.title,
      performer: s.performer,
      likes: s.likes || 0,
      plays: s.plays || 0
    }));

  res.json({ favorite_ids: favIds, items });
});

app.post('/api/favorite/:id', (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const userId = resolveUserId(req.body.init_data, req.body.user_id);
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  const result = toggleFavorite(userId, songId);
  res.json({ status: 'ok', ...result });
});

app.get('/api/random', (req, res) => {
  const active = getActiveSongs();
  if (!active.length) return res.status(404).json({ detail: 'آهنگی یافت نشد' });
  const s = active[Math.floor(Math.random() * active.length)];
  res.json({
    uid: s.uid,
    id: s.id,
    title: s.title,
    performer: s.performer,
    likes: s.likes || 0
  });
});

app.get('/api/stream/:uid', async (req, res) => {
  const song = getActiveSongs().find(s => s.uid === req.params.uid || String(s.id) === req.params.uid);
  if (!song) return res.status(404).json({ detail: 'موزیک یافت نشد' });

  const resolved = await resolvePlayableFile(song);
  if (!resolved || resolved.error) {
    return res.status(404).json({
      detail: `خطای تلگرام: ${resolved?.error || 'فایل قابل استریم نیست'}`
    });
  }

  try {
    const fileUrl = `${TELEGRAM_FILE_API}/${resolved.filePath}`;
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;

    const streamResp = await axios.get(fileUrl, {
      headers,
      responseType: 'stream',
      timeout: 60000,
      validateStatus: status => status >= 200 && status < 300
    });

    song.plays = (song.plays || 0) + 1;

    res.status(streamResp.status);
    res.setHeader('Content-Type', resolved.filePath.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    if (streamResp.headers['content-length']) {
      res.setHeader('Content-Length', streamResp.headers['content-length']);
    }
    if (streamResp.headers['content-range']) {
      res.setHeader('Content-Range', streamResp.headers['content-range']);
    }

    streamResp.data.pipe(res);
  } catch (err) {
    console.error('Stream Error:', err.message);
    if (!res.headersSent) res.status(500).json({ detail: 'خطا در پخش آنلاین' });
  }
});

app.post('/api/send/:uid', async (req, res) => {
  const song = getActiveSongs().find(s => s.uid === req.params.uid || String(s.id) === req.params.uid);
  if (!song) return res.status(404).json({ detail: 'موزیک یافت نشد' });

  const deepLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=song_${song.id}` : '';
  const userId = resolveUserId(req.body.init_data, req.body.user_id);

  if (!userId) {
    return res.status(400).json({
      need_start: true,
      deep_link: deepLink,
      detail: 'در حال انتقال به ربات برای دریافت فایل...'
    });
  }

  const caption = `🎵 ${song.performer} - ${song.title}\n🎧 ارسال شده از مینی‌اپ GapMusic`;
  const resolved = await resolvePlayableFile(song);

  try {
    if (resolved?.fileId) {
      try {
        const r = await axios.post(`${TELEGRAM_API}/sendAudio`, {
          chat_id: userId,
          audio: resolved.fileId,
          caption
        });
        if (r.data.ok) return res.json({ status: 'ok' });
      } catch (e1) {
        const r2 = await axios.post(`${TELEGRAM_API}/sendDocument`, {
          chat_id: userId,
          document: resolved.fileId,
          caption
        });
        if (r2.data.ok) return res.json({ status: 'ok' });
      }
    }

    if (song.from_chat_id && song.message_id) {
      const r3 = await axios.post(`${TELEGRAM_API}/copyMessage`, {
        chat_id: userId,
        from_chat_id: song.from_chat_id,
        message_id: song.message_id,
        caption
      });
      if (r3.data.ok) return res.json({ status: 'ok' });
    }

    res.status(400).json({
      need_start: true,
      deep_link: deepLink,
      detail: 'در حال باز کردن ربات برای تحویل فایل...'
    });
  } catch (err) {
    res.status(400).json({
      need_start: true,
      deep_link: deepLink,
      detail: 'ابتدا باید ربات را استارت کنید.'
    });
  }
});

// ---------------------------------------------------------------------------
// ربات تلگرام Telegraf
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const userSessions = new Map();

function buildMainMenu(userId) {
  const activeCount = getActiveSongs().length;
  const favCount = USERS_DB.users[String(userId)]?.favorites?.length || 0;

  const text =
    `سلام! 👋 به ربات و پلیر هوشمند **GapMusic** خوش آمدید.\n\n` +
    `🎼 آرشیو موزیک‌های فعال: **${activeCount}** ترک 🎵\n` +
    `❤️ پلی‌لیست شخصی شما: **${favCount}** موزیک\n` +
    `📤 هر موزیکی که بفرستید به صورت خودکار به آرشیو اضافه می‌شود!\n\n` +
    `💡 نام خواننده یا آهنگ را تایپ کنید یا وارد پلیر آنلاین شوید:`;

  const rows = [];
  if (MINI_APP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🎧 ورود به مینی‌اپ GapMusic', MINI_APP_URL)]);
  }
  rows.push([
    Markup.button.callback('🎵 کل موزیک‌ها', 'list_all'),
    Markup.button.callback('🎲 موزیک شانسی', 'random_song')
  ]);
  rows.push([
    Markup.button.callback('🔥 پرطرفدارترین‌ها', 'top_songs'),
    Markup.button.callback('🆕 جدیدترین‌ها', 'newest_songs')
  ]);
  rows.push([
    Markup.button.callback(`❤️ پلی‌لیست من (${favCount})`, 'my_favorites'),
    Markup.button.callback('📩 درخواست موزیک', 'request_song')
  ]);
  rows.push([
    Markup.button.switchToCurrentChat('⚡ سرچ آنی (Inline)', ''),
    Markup.button.url('🌐 گپ ما', GROUP_URL)
  ]);

  if (isAdmin(userId)) {
    rows.push([Markup.button.callback('🛡️ پنل مدیریت ادمین', 'admin_panel')]);
  }

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

function buildSongListKeyboard(songs, page = 0, perPage = 6) {
  const totalPages = Math.max(1, Math.ceil(songs.length / perPage));
  const safePage = Math.max(0, Math.min(page, totalPages - 1));
  const slice = songs.slice(safePage * perPage, (safePage + 1) * perPage);

  const rows = slice.map(s => {
    const icon = s.plays >= 10 ? '🔥' : '🎵';
    return [Markup.button.callback(`${icon} ${s.performer} - ${s.title}`.slice(0, 58), `dl_${s.id}`)];
  });

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback('◀️ قبلی', `page_${safePage - 1}`));
  nav.push(Markup.button.callback(`📄 ${safePage + 1} از ${totalPages}`, 'noop'));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback('بعدی ▶️', `page_${safePage + 1}`));
  rows.push(nav);

  if (MINI_APP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🎧 پخش آنلاین در مینی‌اپ', MINI_APP_URL)]);
  }
  rows.push([Markup.button.callback('🔙 منوی اصلی', 'main_menu')]);
  return Markup.inlineKeyboard(rows);
}

async function sendSongToChat(ctx, chatId, song, userId) {
  song.plays = (song.plays || 0) + 1;
  saveSongs();

  const liked = (USERS_DB.users[String(userId)]?.favorites || []).includes(song.id);
  const likeBtnText = liked ? `❤️ در پلی‌لیست (${song.likes})` : `🤍 افزودن به پلی‌لیست (${song.likes})`;

  const rows = [
    [
      Markup.button.callback(likeBtnText, `like_${song.id}`),
      Markup.button.callback('🎲 آهنگ بعدی', 'random_song')
    ]
  ];
  if (isAdmin(userId)) {
    rows.push([Markup.button.callback('🗑️ حذف این آهنگ (ادمین)', `admdel_${song.id}`)]);
  }
  if (MINI_APP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🎧 باز کردن پلیر مینی‌اپ', MINI_APP_URL)]);
  }

  const caption = `🎵 ${song.performer} - ${song.title}\n▶️ دریافت: ${song.plays} مرتبه | 🆔 #${song.id}`;
  const extra = { caption, ...Markup.inlineKeyboard(rows) };

  const resolved = await resolvePlayableFile(song);
  if (resolved?.fileId) {
    try {
      await ctx.telegram.sendAudio(chatId, resolved.fileId, extra);
      return true;
    } catch (e) {
      try {
        await ctx.telegram.sendDocument(chatId, resolved.fileId, extra);
        return true;
      } catch (err) {}
    }
  }

  if (song.from_chat_id && song.message_id) {
    try {
      await ctx.telegram.copyMessage(chatId, song.from_chat_id, song.message_id, extra);
      return true;
    } catch (e) {}
  }

  return false;
}

bot.start(async (ctx) => {
  registerUser(ctx.from);

  const rawText = ctx.message?.text || '';
  const parts = rawText.trim().split(/\s+/);
  const payload = (parts.length > 1 ? parts[1] : '') || ctx.startPayload || '';

  if (payload.startsWith('song_')) {
    const songId = parseInt(payload.replace('song_', ''), 10);
    const song = ALL_SONGS.find(s => s.id === songId);

    if (!song) {
      await ctx.reply('❌ متأسفانه این موزیک در آرشیو پیدا نشد.');
      return;
    }

    const waitMsg = await ctx.reply(`⏳ در حال آماده‌سازی و ارسال «${song.title}»...`);
    const ok = await sendSongToChat(ctx, ctx.chat.id, song, ctx.from.id);
    await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});

    if (ok) return;

    await ctx.reply('⚠️ دسترسی به فایل این موزیک برقرار نشد.');
    return;
  }

  const { text, keyboard } = buildMainMenu(ctx.from.id);
  await ctx.replyWithMarkdown(text, keyboard);
});

bot.command('admin', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const msg =
    `🛡️ **پنل مدیریت ادمین GapMusic**\n\n` +
    `🎵 کل موزیک‌های فعال: **${getActiveSongs().length}**\n` +
    `👥 تعداد کاربران: **${Object.keys(USERS_DB.users).length}**\n` +
    `📩 درخواست‌های ثبت‌شده: **${USERS_DB.requests.length}**\n\n` +
    `📌 **روش‌های حذف آهنگ:**\n` +
    `1️⃣ داخل مینی‌اپ، روی دکمه 🗑️ کنار هر آهنگ بزنید.\n` +
    `2️⃣ دستور \`/del کد_آهنگ\` را بفرستید (مثلاً: \`/del 125\`).`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.webApp('🛡️ ورود به پنل مدیریتی در مینی‌اپ', MINI_APP_URL)],
    [Markup.button.callback('📦 دریافت فایل دیتابیس', 'admin_export')]
  ]));
});

bot.command('del', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const songId = parseInt(parts[1], 10);
  if (!songId) return ctx.reply('⚠️ فرمت صحیح: `/del 120`', { parse_mode: 'Markdown' });

  const removed = deleteSongById(songId);
  if (!removed) return ctx.reply('❌ آهنگی با این کد پیدا نشد.');
  await ctx.reply(`🗑️ موزیک «${removed.performer} - ${removed.title}» (کد #${songId}) با موفقیت حذف شد.`);
});

bot.action('admin_panel', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('دسترسی غیرمجاز', { show_alert: true });
  const msg =
    `🛡️ **پنل مدیریت ادمین GapMusic**\n\n` +
    `🎵 کل موزیک‌های فعال: **${getActiveSongs().length}**\n` +
    `👥 تعداد کاربران: **${Object.keys(USERS_DB.users).length}**\n` +
    `📩 درخواست‌های ثبت‌شده: **${USERS_DB.requests.length}**\n\n` +
    `💡 برای حذف سریع: دستور \`/del کد_آهنگ\` را بفرستید یا در مینی‌اپ آیکون 🗑️ را بزنید.`;

  await ctx.editMessageText(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.webApp('🛡️ مدیریت و حذف در مینی‌اپ', MINI_APP_URL)],
      [Markup.button.callback('📦 دریافت فایل دیتابیس', 'admin_export')],
      [Markup.button.callback('🔙 منوی اصلی', 'main_menu')]
    ])
  }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('admin_export', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery('📦 در حال ارسال فایل...');
  if (fs.existsSync(DB_FILE)) {
    await ctx.replyWithDocument(
      { source: DB_FILE, filename: 'songs_db.json' },
      { caption: `📦 بکاپ دیتابیس | کل آهنگ‌ها: ${ALL_SONGS.length}` }
    );
  }
});

bot.action(/^admdel_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('فقط ادمین اجازه حذف دارد!', { show_alert: true });
  const songId = parseInt(ctx.match[1], 10);
  const removed = deleteSongById(songId);
  if (!removed) return ctx.answerCbQuery('قبلاً حذف شده است.', { show_alert: true });
  await ctx.answerCbQuery(`🗑️ آهنگ #${songId} حذف شد!`, { show_alert: true });
  await ctx.deleteMessage().catch(() => {});
});

bot.command('export_db', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  if (!fs.existsSync(DB_FILE)) return ctx.reply('❌ فایل songs_db.json یافت نشد.');
  await ctx.replyWithDocument(
    { source: DB_FILE, filename: 'songs_db.json' },
    { caption: `📦 فایل دیتابیس | کل آهنگ‌ها: ${ALL_SONGS.length}` }
  );
});

bot.action('noop', (ctx) => ctx.answerCbQuery());

bot.action('main_menu', async (ctx) => {
  registerUser(ctx.from);
  userSessions.delete(ctx.from.id);
  const { text, keyboard } = buildMainMenu(ctx.from.id);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard }).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('list_all', async (ctx) => {
  const songs = [...getActiveSongs()].reverse();
  userSessions.set(ctx.from.id, { list: songs.map(s => s.id) });
  await ctx.editMessageText(`🎵 کل موزیک‌های فعال (${songs.length} ترک):`, buildSongListKeyboard(songs, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('top_songs', async (ctx) => {
  const songs = [...getActiveSongs()].sort((a, b) => (b.plays - a.plays) || (b.likes - a.likes)).slice(0, 60);
  userSessions.set(ctx.from.id, { list: songs.map(s => s.id) });
  await ctx.editMessageText('🔥 پرطرفدارترین موزیک‌ها:', buildSongListKeyboard(songs, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('newest_songs', async (ctx) => {
  const songs = [...getActiveSongs()].sort((a, b) => b.id - a.id).slice(0, 60);
  userSessions.set(ctx.from.id, { list: songs.map(s => s.id) });
  await ctx.editMessageText('🆕 جدیدترین موزیک‌های آرشیو:', buildSongListKeyboard(songs, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('my_favorites', async (ctx) => {
  const favIds = USERS_DB.users[String(ctx.from.id)]?.favorites || [];
  if (!favIds.length) {
    return ctx.answerCbQuery('پلی‌لیست شما خالی است! زیر آهنگ‌ها روی 🤍 بزنید.', { show_alert: true });
  }
  const map = new Map(getActiveSongs().map(s => [s.id, s]));
  const songs = [...favIds].reverse().map(id => map.get(id)).filter(Boolean);
  userSessions.set(ctx.from.id, { list: songs.map(s => s.id) });
  await ctx.editMessageText(`❤️ پلی‌لیست شخصی شما (${songs.length} ترک):`, buildSongListKeyboard(songs, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('random_song', async (ctx) => {
  const songs = getActiveSongs();
  if (!songs.length) return ctx.answerCbQuery('آهنگی یافت نشد', { show_alert: true });
  const song = songs[Math.floor(Math.random() * songs.length)];
  await ctx.answerCbQuery('🎲 در حال ارسال موزیک شانسی...');
  await sendSongToChat(ctx, ctx.chat.id, song, ctx.from.id);
});

bot.action('request_song', async (ctx) => {
  userSessions.set(ctx.from.id, { awaitingRequest: true });
  await ctx.editMessageText(
    '📩 نام آهنگ و خواننده مورد نظر خود را تایپ و ارسال کنید:',
    Markup.inlineKeyboard([[Markup.button.callback('🔙 انصراف', 'main_menu')]])
  ).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action(/^dl_(\d+)$/, async (ctx) => {
  const songId = parseInt(ctx.match[1], 10);
  const song = getActiveSongs().find(s => s.id === songId);
  if (!song) return ctx.answerCbQuery('موزیک یافت نشد', { show_alert: true });
  await ctx.answerCbQuery('⏳ در حال ارسال...');
  await sendSongToChat(ctx, ctx.chat.id, song, ctx.from.id);
});

bot.action(/^like_(\d+)$/, async (ctx) => {
  const songId = parseInt(ctx.match[1], 10);
  const { liked, likes } = toggleFavorite(ctx.from.id, songId);
  const likeBtnText = liked ? `❤️ در پلی‌لیست (${likes})` : `🤍 افزودن به پلی‌لیست (${likes})`;

  const rows = [
    [
      Markup.button.callback(likeBtnText, `like_${songId}`),
      Markup.button.callback('🎲 آهنگ بعدی', 'random_song')
    ]
  ];
  if (isAdmin(ctx.from.id)) {
    rows.push([Markup.button.callback('🗑️ حذف این آهنگ (ادمین)', `admdel_${songId}`)]);
  }
  if (MINI_APP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🎧 باز کردن پلیر مینی‌اپ', MINI_APP_URL)]);
  }
  await ctx.editMessageReplyMarkup(Markup.inlineKeyboard(rows).reply_markup).catch(() => {});
  await ctx.answerCbQuery(liked ? '❤️ به پلی‌لیست اضافه شد!' : '💔 از پلی‌لیست حذف شد.');
});

bot.action(/^page_(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1], 10);
  const session = userSessions.get(ctx.from.id);
  if (!session || !session.list) {
    return ctx.answerCbQuery('نتایج منقضی شده‌اند، دوباره جستجو کنید.', { show_alert: true });
  }
  const map = new Map(getActiveSongs().map(s => [s.id, s]));
  const songs = session.list.map(id => map.get(id)).filter(Boolean);
  await ctx.editMessageReplyMarkup(buildSongListKeyboard(songs, page).reply_markup).catch(() => {});
  await ctx.answerCbQuery();
});

bot.on(['audio', 'document', 'channel_post'], async (ctx, next) => {
  const msg = ctx.message || ctx.channelPost;
  if (!msg) return next();

  const audio = msg.audio || (msg.document && (msg.document.mime_type || '').startsWith('audio/') ? msg.document : null);
  if (!audio) return next();

  if (ctx.from) registerUser(ctx.from);

  const rawTitle = audio.title || (audio.file_name ? path.parse(audio.file_name).name : 'نامشخص');
  const title = cleanDisplayText(rawTitle);
  const performer = cleanDisplayText(audio.performer || 'نامشخص');
  const normSearch = normalizeText(`${title} ${performer}`);

  const exists = ALL_SONGS.find(s =>
    (audio.file_unique_id && s.file_unique_id && s.file_unique_id === audio.file_unique_id) ||
    (normSearch.length > 3 && s.search_text === normSearch)
  );

  if (exists) {
    exists.file_id = audio.file_id;
    exists.file_unique_id = audio.file_unique_id || exists.file_unique_id;
    exists.from_chat_id = ctx.chat.id;
    exists.message_id = msg.message_id;
    exists.available = true;
    saveSongs();

    updatedCounter++;
    if (!ctx.channelPost) {
      if (isAdmin(ctx.from?.id) && updatedCounter % 50 === 0) {
        ctx.reply(`🔄 تا این لحظه ${updatedCounter} آهنگ بروزرسانی شد!`).catch(() => {});
      } else if (!isAdmin(ctx.from?.id)) {
        ctx.reply(`⚠️ این موزیک قبلاً با کد #${exists.id} در آرشیو ثبت شده است.`).catch(() => {});
      }
    }
    return;
  }

  const newId = ALL_SONGS.reduce((max, s) => Math.max(max, s.id), 0) + 1;
  const newSong = {
    id: newId,
    uid: `${newId}_${msg.message_id}`,
    from_chat_id: ctx.chat.id,
    message_id: msg.message_id,
    file_id: audio.file_id,
    file_unique_id: audio.file_unique_id || '',
    title,
    performer,
    search_text: normSearch,
    media_type: msg.audio ? 'audio' : 'document',
    plays: 0,
    likes: 0,
    available: true
  };

  ALL_SONGS.push(newSong);
  saveSongs();

  if (!ctx.channelPost) {
    await ctx.reply(`✅ موزیک شما با موفقیت به آرشیو عمومی اضافه شد!\n🎤 خواننده: ${performer}\n🎵 عنوان: ${title}\n🆔 کد موزیک: #${newId}`).catch(() => {});

    if (ctx.from && !isAdmin(ctx.from.id)) {
      for (const adm of ADMIN_IDS) {
        ctx.telegram.sendMessage(
          adm,
          `➕ موزیک جدید توسط کاربر اضافه شد:\n👤 ${ctx.from.first_name} (${ctx.from.id})\n🎵 ${performer} - ${title}\n🆔 کد: #${newId} (برای حذف: /del ${newId})`
        ).catch(() => {});
      }
    }
  }
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (!text || text.startsWith('/')) return;
  registerUser(ctx.from);

  let query = text;
  if (ctx.chat.type !== 'private') {
    if (text.startsWith('موزیک ')) query = text.slice(6).trim();
    else return;
  }

  const session = userSessions.get(ctx.from.id);
  if (ctx.chat.type === 'private' && session?.awaitingRequest) {
    userSessions.delete(ctx.from.id);
    USERS_DB.requests.push({
      id: USERS_DB.requests.length + 1,
      user_id: ctx.from.id,
      user_name: ctx.from.first_name || '',
      query,
      status: 'pending',
      created_at: Math.floor(Date.now() / 1000)
    });
    saveUsers();
    await ctx.reply(`✅ درخواست شما برای «${query}» ثبت شد و به زودی به آرشیو اضافه می‌شود.`);
    for (const adm of ADMIN_IDS) {
      ctx.telegram.sendMessage(adm, `📩 درخواست موزیک جدید از ${ctx.from.first_name}:\n🎵 ${query}`).catch(() => {});
    }
    return;
  }

  const normQ = normalizeText(query);
  const tokens = normQ.split(' ');
  const active = getActiveSongs();
  const exact = active.filter(s => tokens.every(t => s.search_text.includes(t)));
  const partial = active.filter(s => !exact.includes(s) && tokens.some(t => s.search_text.includes(t)));
  const results = [...exact, ...partial];

  if (!results.length) {
    return ctx.reply(
      `❌ آهنگی برای «${query}» یافت نشد.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📩 درخواست این موزیک', 'request_song')],
        [Markup.button.callback('🎲 موزیک شانسی', 'random_song')]
      ])
    );
  }

  userSessions.set(ctx.from.id, { list: results.map(s => s.id) });
  await ctx.reply(
    `🔍 نتایج جستجو برای «${query}» (${results.length} ترک):`,
    buildSongListKeyboard(results, 0)
  );
});

bot.on('inline_query', async (ctx) => {
  const q = normalizeText(ctx.inlineQuery.query);
  let songs = getActiveSongs().filter(s => s.media_type === 'audio' && s.file_id);

  if (q) {
    const tokens = q.split(' ');
    songs = songs.filter(s => tokens.some(t => s.search_text.includes(t)));
  } else {
    songs = [...songs].sort((a, b) => b.plays - a.plays);
  }

  const results = songs.slice(0, 25).map(s => ({
    type: 'audio',
    id: String(s.id),
    audio_file_id: s.file_id,
    caption: `🎵 ${s.performer} - ${s.title}`
  }));

  await ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true });
});

app.listen(PORT, async () => {
  console.log(`🚀 سرور مینی‌اپ روی پورت ${PORT} با موفقیت بالا آمد.`);
  try {
    const me = await bot.telegram.getMe();
    BOT_USERNAME = me.username || '';
    console.log(`🤖 نام کاربری ربات: @${BOT_USERNAME}`);
  } catch (e) {}

  if (MINI_APP_URL.startsWith('https://')) {
    try {
      await bot.telegram.setChatMenuButton({
        menuButton: {
          type: 'web_app',
          text: 'پلیر',
          web_app: { url: MINI_APP_URL }
        }
      });
    } catch (e) {}
  }

  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🤖 ربات تلگرام آنلاین شد!'))
    .catch((err) => console.error('⚠️ خطا در اتصال ربات:', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
