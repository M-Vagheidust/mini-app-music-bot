require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// تنظیمات اصلی
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN || '8973013935:AAE9N-n3I8jKWg9TWu_wmZICZDaeD6zzFbw';
const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://mini-app-music-bot-production.up.railway.app').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '8000', 10);
const ADMIN_IDS = [849152312];
const GROUP_URL = 'https://t.me/+k1KWTCq0FMswZjM0';

const DB_FILE = path.join(__dirname, 'songs_db.json');
const USERS_DB_FILE = path.join(__dirname, 'users_db.json');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

// ---------------------------------------------------------------------------
// مدیریت دیتابیس‌ها (خواندن و ذخیره اتمیک)
// ---------------------------------------------------------------------------
let ALL_SONGS = [];
let USERS_DB = { users: {}, requests: [] };

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
  } catch (err) {
    console.error('❌ خطا در ذخیره songs_db.json:', err.message);
  }
}

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_DB_FILE)) {
      USERS_DB = { users: {}, requests: [] };
      return;
    }
    const raw = fs.readFileSync(USERS_DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    USERS_DB = {
      users: data.users || {},
      requests: data.requests || []
    };
  } catch (err) {
    console.error('❌ خطا در خواندن users_db.json:', err.message);
  }
}

function saveUsers() {
  try {
    const tmp = `${USERS_DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(USERS_DB, null, 2), 'utf8');
    fs.renameSync(tmp, USERS_DB_FILE);
  } catch (err) {
    console.error('❌ خطا در ذخیره users_db.json:', err.message);
  }
}

function getActiveSongs() {
  return ALL_SONGS.filter(s => s.available && isPlayable(s));
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

function verifyInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const keys = Array.from(params.keys()).sort();
    const dataCheckString = keys.map(k => `${k}=${params.get(k)}`).join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const calcHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (calcHash === hash && params.has('user')) {
      return JSON.parse(params.get('user'));
    }
  } catch (e) {}
  return null;
}

// بارگذاری اولیه دیتابیس‌ها
loadSongs();
loadUsers();

// ---------------------------------------------------------------------------
// بخش ۱: سرور وب Express و API های مینی‌اپ
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'templates')));

app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'templates', 'index.html');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.send('<h1>GapMusic Mini App Active</h1>');
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', songs: getActiveSongs().length });
});

// دریافت لیست موزیک‌ها با جستجوی هوشمند
app.get('/api/songs', (req, res) => {
  const q = normalizeText(req.query.q || '');
  const streamOnly = req.query.stream_only === 'true';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 40));

  let songs = [...getActiveSongs()].reverse();
  if (streamOnly) {
    songs = songs.filter(s => Boolean(s.file_id));
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
    can_stream: Boolean(s.file_id),
    likes: s.likes || 0
  }));

  res.json({ total, items });
});

// دریافت و تغییر وضعیت علاقه‌مندی‌ها (همگام با ربات)
app.get('/api/favorites', (req, res) => {
  const verified = verifyInitData(req.query.init_data || '');
  const userId = verified ? verified.id : req.query.user_id;
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
      can_stream: Boolean(s.file_id),
      likes: s.likes || 0
    }));

  res.json({ favorite_ids: favIds, items });
});

app.post('/api/favorite/:id', (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const verified = verifyInitData(req.body.init_data || '');
  const userId = verified ? verified.id : req.body.user_id;
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  const result = toggleFavorite(userId, songId);
  res.json({ status: 'ok', ...result });
});

// موزیک شانسی
app.get('/api/random', (req, res) => {
  const streamable = getActiveSongs().filter(s => Boolean(s.file_id));
  if (!streamable.length) return res.status(404).json({ detail: 'آهنگی یافت نشد' });
  const s = streamable[Math.floor(Math.random() * streamable.length)];
  res.json({
    uid: s.uid,
    id: s.id,
    title: s.title,
    performer: s.performer,
    can_stream: true
  });
});

// استریم مستقیم فایل صوتی از تلگرام به پلیر مینی‌اپ
app.get('/api/stream/:uid', async (req, res) => {
  const song = getActiveSongs().find(s => s.uid === req.params.uid || String(s.id) === req.params.uid);
  if (!song || !song.file_id) {
    return res.status(404).json({ detail: 'فایل صوتی یافت نشد' });
  }

  try {
    const fileInfo = await axios.get(`${TELEGRAM_API}/getFile`, {
      params: { file_id: song.file_id },
      timeout: 15000
    });
    if (!fileInfo.data.ok) {
      return res.status(502).json({ detail: 'خطا در دریافت فایل از تلگرام' });
    }

    const filePath = fileInfo.data.result.file_path;
    const fileUrl = `${TELEGRAM_FILE_API}/${filePath}`;
    const streamResp = await axios.get(fileUrl, { responseType: 'stream', timeout: 60000 });

    res.setHeader('Content-Type', filePath.endsWith('.m4a') ? 'audio/mp4' : 'audio/mpeg');
    if (streamResp.headers['content-length']) {
      res.setHeader('Content-Length', streamResp.headers['content-length']);
    }
    res.setHeader('Accept-Ranges', 'bytes');

    streamResp.data.pipe(res);
  } catch (err) {
    console.error('Stream Error:', err.message);
    if (!res.headersSent) res.status(500).json({ detail: 'خطا در پخش آنلاین' });
  }
});

// ارسال موزیک به چت خصوصی کاربر
app.post('/api/send/:uid', async (req, res) => {
  const verified = verifyInitData(req.body.init_data || '');
  const userId = verified ? verified.id : req.body.user_id;
  if (!userId) return res.status(400).json({ detail: 'شناسه کاربر یافت نشد' });

  const song = getActiveSongs().find(s => s.uid === req.params.uid || String(s.id) === req.params.uid);
  if (!song) return res.status(404).json({ detail: 'موزیک یافت نشد' });

  try {
    if (song.file_id) {
      const r = await axios.post(`${TELEGRAM_API}/sendAudio`, {
        chat_id: userId,
        audio: song.file_id,
        caption: `🎵 ${song.performer} - ${song.title}\n🎧 ارسال شده از مینی‌اپ GapMusic`
      });
      if (r.data.ok) return res.json({ status: 'ok' });
    }
    if (song.from_chat_id && song.message_id) {
      const r = await axios.post(`${TELEGRAM_API}/copyMessage`, {
        chat_id: userId,
        from_chat_id: song.from_chat_id,
        message_id: song.message_id
      });
      if (r.data.ok) return res.json({ status: 'ok' });
    }
    res.status(500).json({ detail: 'ارسال به چت انجام نشد' });
  } catch (err) {
    res.status(500).json({ detail: 'خطا در ارتباط با تلگرام' });
  }
});

// ---------------------------------------------------------------------------
// بخش ۲: ربات تلگرام Telegraf (کاملاً همگام با مینی‌اپ)
// ---------------------------------------------------------------------------
const bot = new Telegraf(BOT_TOKEN);
const userSessions = new Map();

function buildMainMenu(userId) {
  const activeCount = getActiveSongs().length;
  const favCount = USERS_DB.users[String(userId)]?.favorites?.length || 0;

  const text =
    `سلام! 👋 به ربات و پلیر هوشمند **GapMusic** خوش آمدید.\n\n` +
    `🎼 آرشیو موزیک‌های فعال: **${activeCount}** ترک 🎵\n` +
    `❤️ پلی‌لیست شخصی شما: **${favCount}** موزیک\n\n` +
    `💡 نام خواننده یا آهنگ را تایپ کنید یا با دکمه زیر وارد پلیر آنلاین شوید:`;

  const rows = [];
  if (MINI_APP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🎧 ورود به مینی‌اپ GapMusic (پخش آنلاین)', MINI_APP_URL)]);
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
  if (MINI_APP_URL.startsWith('https://')) {
    rows.push([Markup.button.webApp('🎧 باز کردن پلیر مینی‌اپ', MINI_APP_URL)]);
  }

  const caption = `🎵 ${song.performer} - ${song.title}\n▶️ دریافت: ${song.plays} مرتبه | 🆔 #${song.id}`;
  const extra = { caption, ...Markup.inlineKeyboard(rows) };

  try {
    if (song.from_chat_id && song.message_id) {
      await ctx.telegram.copyMessage(chatId, song.from_chat_id, song.message_id, extra);
      return true;
    }
  } catch (e) {}

  if (song.file_id) {
    try {
      await ctx.telegram.sendAudio(chatId, song.file_id, extra);
      return true;
    } catch (e) {
      try {
        await ctx.telegram.sendDocument(chatId, song.file_id, extra);
        return true;
      } catch (err) {}
    }
  }
  return false;
}

bot.start(async (ctx) => {
  registerUser(ctx.from);
  const { text, keyboard } = buildMainMenu(ctx.from.id);
  await ctx.replyWithMarkdown(text, keyboard);
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

// ذخیره خودکار فایل‌های صوتی ارسال شده به ربات یا کانال
bot.on(['audio', 'document', 'channel_post'], async (ctx, next) => {
  const msg = ctx.message || ctx.channelPost;
  if (!msg) return next();

  const audio = msg.audio || (msg.document && (msg.document.mime_type || '').startsWith('audio/') ? msg.document : null);
  if (!audio) return next();

  const exists = ALL_SONGS.find(s =>
    (audio.file_unique_id && s.file_unique_id === audio.file_unique_id) ||
    s.file_id === audio.file_id
  );

  if (exists) {
    if (!ctx.channelPost) {
      const m = await ctx.reply(`⚠️ این موزیک قبلاً با کد #${exists.id} ثبت شده است.`);
      setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
    }
    return;
  }

  const newId = ALL_SONGS.reduce((max, s) => Math.max(max, s.id), 0) + 1;
  const rawTitle = audio.title || (audio.file_name ? path.parse(audio.file_name).name : 'نامشخص');
  const title = cleanDisplayText(rawTitle);
  const performer = cleanDisplayText(audio.performer || 'نامشخص');

  const newSong = {
    id: newId,
    uid: `${newId}_${msg.message_id}`,
    from_chat_id: ctx.chat.id,
    message_id: msg.message_id,
    file_id: audio.file_id,
    file_unique_id: audio.file_unique_id || '',
    title,
    performer,
    search_text: normalizeText(`${title} ${performer}`),
    media_type: msg.audio ? 'audio' : 'document',
    plays: 0,
    likes: 0,
    available: true
  };

  ALL_SONGS.push(newSong);
  saveSongs();

  if (!ctx.channelPost) {
    const m = await ctx.reply(`✅ موزیک با موفقیت ذخیره شد!\n🎤 خواننده: ${performer}\n🎵 عنوان: ${title}\n📌 کد: #${newId}`);
    setTimeout(() => ctx.telegram.deleteMessage(ctx.chat.id, m.message_id).catch(() => {}), 5000);
  }
});

// جستجوی متنی و ثبت درخواست
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

// جستجوی اینلاین
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

// ---------------------------------------------------------------------------
// اجرای همزمان سرور وب و ربات (بدون کرش کردن سرور وب)
// ---------------------------------------------------------------------------
app.listen(PORT, async () => {
  console.log(`🚀 سرور مینی‌اپ روی پورت ${PORT} با موفقیت بالا آمد.`);

  if (MINI_APP_URL.startsWith('https://')) {
    try {
      await bot.telegram.setChatMenuButton({
        menuButton: {
          type: 'web_app',
          text: '🎧 پلیر GapMusic',
          web_app: { url: MINI_APP_URL }
        }
      });
      console.log(`✅ دکمه منوی مینی‌اپ تنظیم شد: ${MINI_APP_URL}`);
    } catch (e) {
      console.warn('⚠️ عدم امکان تنظیم دکمه منو:', e.message);
    }
  }

  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🤖 ربات تلگرام آنلاین شد!'))
    .catch((err) => console.error('⚠️ خطا در اتصال ربات (سرور وب همچنان فعال است):', err.message));
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
