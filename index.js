require('dotenv').config();
const express = require('express');
const { Telegraf, Markup } = require('telegraf');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const BOT_TOKEN = process.env.BOT_TOKEN || '8973013935:AAE9N-n3I8jKWg9TWu_wmZICZDaeD6zzFbw';
const MINI_APP_URL = (process.env.MINI_APP_URL || 'https://mini-app-music-bot-production.up.railway.app').replace(/\/$/, '');
const PORT = parseInt(process.env.PORT || '8080', 10);
const ADMIN_IDS = [849152312];
const GROUP_URL = 'https://t.me/+k1KWTCq0FMswZjM0';

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'gapmusic.db');

const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const TELEGRAM_FILE_API = `https://api.telegram.org/file/bot${BOT_TOKEN}`;

let BOT_USERNAME = '';
const COVER_CACHE = new Map();

// ---------------------------------------------------------------------------
// اتصال به دیتابیس SQLite (منطبق با ساختار gapmusic.db)
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY,
    uid TEXT UNIQUE,
    from_chat_id TEXT,
    message_id INTEGER,
    file_id TEXT,
    file_unique_id TEXT,
    title TEXT,
    performer TEXT,
    search_text TEXT,
    media_type TEXT DEFAULT 'audio',
    plays INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    available INTEGER DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_songs_plays ON songs (plays DESC);
  CREATE INDEX IF NOT EXISTS idx_songs_likes ON songs (likes DESC);
  CREATE INDEX IF NOT EXISTS idx_songs_id_desc ON songs (id DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS songs_fts USING fts5(
    id UNINDEXED,
    title,
    performer,
    search_text
  );

  CREATE TRIGGER IF NOT EXISTS songs_ai AFTER INSERT ON songs BEGIN
    INSERT INTO songs_fts(id, title, performer, search_text)
    VALUES (new.id, new.title, new.performer, new.search_text);
  END;

  CREATE TRIGGER IF NOT EXISTS songs_ad AFTER DELETE ON songs BEGIN
    DELETE FROM songs_fts WHERE id = old.id;
  END;

  CREATE TRIGGER IF NOT EXISTS songs_au AFTER UPDATE ON songs BEGIN
    DELETE FROM songs_fts WHERE id = old.id;
    INSERT INTO songs_fts(id, title, performer, search_text)
    VALUES (new.id, new.title, new.performer, new.search_text);
  END;

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    username TEXT,
    joined_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS favorites (
    user_id TEXT,
    song_id INTEGER,
    created_at INTEGER,
    PRIMARY KEY (user_id, song_id)
  );

  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    user_name TEXT,
    query TEXT,
    expanded_query TEXT,
    status TEXT DEFAULT 'pending',
    fulfilled_song_id INTEGER,
    created_at INTEGER,
    fulfilled_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS lyrics_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    song_key TEXT UNIQUE,
    synced_lyrics TEXT,
    plain_lyrics TEXT,
    cached_at INTEGER
  );
`);

function isAdmin(userId) {
  return ADMIN_IDS.includes(Number(userId));
}

// دیکشنری هوشمند معادل‌سازی فارسی و انگلیسی برای جستجوی دوزبانه
const BILINGUAL_ALIASES = [
  ['tataloo', 'تتلو', 'امیر تتلو'],
  ['yas', 'یاس'],
  ['shayea', 'شایع'],
  ['pishro', 'پیشرو', 'رضا پیشرو'],
  ['hichkas', 'هیچکس'],
  ['ho3ein', 'حصین', 'hosein'],
  ['mehrad hidden', 'مهراد هیدن', 'هیدن', 'hidden'],
  ['zedbazi', 'زدبازی'],
  ['sohrab mj', 'سهراب ام جی', 'ام جی'],
  ['alireza jj', 'علیرضا جی جی', 'جی جی'],
  ['sijal', 'سیجل'],
  ['behzad leito', 'بهزاد لیتو', 'لیتو', 'leito'],
  ['khalse', 'سپهر خلسه', 'خلسه'],
  ['putak', 'پوتک', 'پوریا پوتک'],
  ['chvrsi', 'چرسی', 'charsi'],
  ['hiphopologist', 'هیپهاپولوژیست'],
  ['vinak', 'ویناک'],
  ['021kid', '۰۲۱کید', '021'],
  ['dorcci', 'دورچی', 'dorci'],
  ['koorosh', 'کوروش'],
  ['artin', 'ارتین'],
  ['erfan', 'عرفان', 'پایدار'],
  ['isogand', 'سوگند', 'sogand'],
  ['shadmehr', 'شادمهر', 'شادمهر عقیلی'],
  ['ebi', 'ابی'],
  ['dariush', 'داریوش'],
  ['siavash ghomayshi', 'سیاوش قمیشی', 'قمیشی'],
  ['moein', 'معین'],
  ['haydeh', 'هایده', 'hayedeh'],
  ['mahasti', 'مهستی'],
  ['googoosh', 'گوگوش'],
  ['chavoshi', 'محسن چاوشی', 'چاوشی'],
  ['yegane', 'محسن یگانه', 'یگانه'],
  ['sirvan', 'سیروان', 'سیروان خسروی'],
  ['xaniar', 'زانیار', 'زانیار خسروی'],
  ['macan', 'ماکان', 'ماکان بند'],
  ['ashvan', 'اشوان'],
  ['aron afshar', 'آرون افشار'],
  ['garsha rezaei', 'گرشا رضایی'],
  ['reza bahram', 'رضا بهرام'],
  ['ali yasini', 'علی یاسینی'],
  ['haamim', 'حامیم', 'hamim'],
  ['the weeknd', 'weeknd', 'ویکند', 'د ویکند'],
  ['drake', 'دریک'],
  ['eminem', 'امینم'],
  ['travis scott', 'تراویس اسکات', 'تراویس'],
  ['kendrick lamar', 'کندریک لامار', 'کندریک'],
  ['kanye west', 'کانیه وست', 'کانیه'],
  ['post malone', 'پست مالون'],
  ['billie eilish', 'بیلی آیلیش'],
  ['lana del rey', 'لانا دل ری'],
  ['taylor swift', 'تیلور سوئیفت'],
  ['adele', 'ادل'],
  ['rihanna', 'ریحانا'],
  ['beyonce', 'بیانسه'],
  ['justin bieber', 'جاستین بیبر'],
  ['selena gomez', 'سلنا گومز'],
  ['dua lipa', 'دوا لیپا'],
  ['shakira', 'شکیرا'],
  ['ed sheeran', 'اد شیرن'],
  ['coldplay', 'کلدپلی'],
  ['imagine dragons', 'ایمجین دراگونز'],
  ['xxxtenacion', 'xxxtentacion', 'تنتاسیون', 'ایکس'],
  ['juice wrld', 'جویس ورلد'],
  ['2pac', 'tupac', 'توپاک'],
  ['snoop dogg', 'اسنوپ داگ'],
  ['50 cent', 'فیفتی سنت'],
  ['central cee', 'سنترال سی'],
  ['metro boomin', 'مترو بومین'],
  ['future', 'فیوچر'],
  ['21 savage', '۲۱ سویج', 'تونی وان سویج'],
  ['playboi carti', 'پلی بوی کارتی'],
  ['lil wayne', 'لیل وین'],
  ['tame impala', 'تیم ایمپالا'],
  ['arctic monkeys', 'آرکتیک مانکیز'],
  ['daft punk', 'دفت پانک'],
  ['alan walker', 'آلن واکر'],
  ['marshmello', 'مارشملو'],
  ['remix', 'ریمیکس'],
  ['slowed', 'اسلود'],
  ['reverb', 'ریورب']
];

function normalizeText(text) {
  if (!text) return '';
  let t = String(text).toLowerCase();
  const map = {
    'ي': 'ی', 'ك': 'ک', 'آ': 'ا', 'أ': 'ا', 'إ': 'ا',
    'ۀ': 'ه', 'ة': 'ه', 'ؤ': 'و', 'ئ': 'ی',
    '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4',
    '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
    '\u200c': ' ', '_': ' ', '-': ' ', '.': ' ', '/': ' ', '\\': ' '
  };
  for (const [k, v] of Object.entries(map)) {
    t = t.split(k).join(v);
  }
  return t.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function persianToLatinPhonetic(text) {
  const norm = normalizeText(text);
  if (!/[آ-ی]/.test(norm)) return norm;

  const charMap = {
    'ا': 'a', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ط': 't', 'ث': 's', 'س': 's', 'ص': 's',
    'ج': 'j', 'چ': 'ch', 'ح': 'h', 'ه': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ز': 'z',
    'ض': 'z', 'ظ': 'z', 'ر': 'r', 'ژ': 'zh', 'ش': 'sh', 'ع': 'a', 'غ': 'gh', 'ق': 'gh',
    'ف': 'f', 'ک': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm', 'ن': 'n', 'و': 'o', 'ی': 'i'
  };

  let out = '';
  for (const ch of norm) {
    out += charMap[ch] !== undefined ? charMap[ch] : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}

function expandBilingualTerms(text) {
  const norm = normalizeText(text);
  if (!norm) return '';

  const extras = new Set([norm]);
  const phonetic = persianToLatinPhonetic(norm);
  if (phonetic && phonetic !== norm) extras.add(phonetic);

  for (const group of BILINGUAL_ALIASES) {
    const normGroup = group.map(g => normalizeText(g));
    if (normGroup.some(alias => alias && (norm.includes(alias) || (alias.includes(norm) && norm.length >= 3)))) {
      normGroup.forEach(a => extras.add(a));
    }
  }

  return Array.from(extras).join(' ');
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

// ---------------------------------------------------------------------------
// توابع دسترسی به SQLite
// ---------------------------------------------------------------------------
const ACTIVE_WHERE = "available = 1 AND (COALESCE(TRIM(file_id), '') != '' OR (from_chat_id IS NOT NULL AND message_id IS NOT NULL))";

function getActiveSongsCount() {
  return db.prepare(`SELECT COUNT(*) AS c FROM songs WHERE ${ACTIVE_WHERE}`).get().c;
}

function getUsersCount() {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
}

function getRequestsCount(onlyPending = false) {
  if (onlyPending) {
    return db.prepare("SELECT COUNT(*) AS c FROM requests WHERE status = 'pending'").get().c;
  }
  return db.prepare('SELECT COUNT(*) AS c FROM requests').get().c;
}

function getSongById(songId) {
  return db.prepare('SELECT * FROM songs WHERE id = ?').get(Number(songId));
}

function getActiveSongByUidOrId(uidOrId) {
  return db.prepare(`SELECT * FROM songs WHERE ${ACTIVE_WHERE} AND (uid = ? OR id = ?) LIMIT 1`)
    .get(String(uidOrId), Number(uidOrId) || -1);
}

function getSongsPage(filter = 'all', offset = 0, limit = 60) {
  const orderBy = filter === 'popular' ? 'plays DESC, likes DESC, id DESC' : 'id DESC';
  const total = getActiveSongsCount();
  const items = db.prepare(`
    SELECT id, uid, title, performer, likes, plays
    FROM songs
    WHERE ${ACTIVE_WHERE}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  return { total, items };
}

function getSongsByIds(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT * FROM songs WHERE ${ACTIVE_WHERE} AND id IN (${placeholders})`).all(...ids);
  const map = new Map(rows.map(r => [r.id, r]));
  return ids.map(id => map.get(id)).filter(Boolean);
}

function getRandomActiveSong() {
  return db.prepare(`SELECT * FROM songs WHERE ${ACTIVE_WHERE} ORDER BY RANDOM() LIMIT 1`).get();
}

function incrementSongPlays(songId) {
  db.prepare('UPDATE songs SET plays = COALESCE(plays, 0) + 1 WHERE id = ?').run(songId);
}

function deleteSongById(songId) {
  const song = getSongById(songId);
  if (!song) return null;
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM songs WHERE id = ?').run(Number(songId));
    db.prepare('DELETE FROM favorites WHERE song_id = ?').run(Number(songId));
  });
  tx();
  return song;
}

function registerUser(user) {
  if (!user || !user.id) return;
  const uid = String(user.id);
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.name || '';
  const username = user.username || '';
  const now = Math.floor(Date.now() / 1000);

  db.prepare(`
    INSERT INTO users (id, name, username, joined_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = CASE WHEN excluded.name != '' THEN excluded.name ELSE users.name END,
      username = CASE WHEN excluded.username != '' THEN excluded.username ELSE users.username END
  `).run(uid, fullName, username, now);
}

function getUserById(userId) {
  if (!userId) return null;
  return db.prepare('SELECT * FROM users WHERE id = ?').get(String(userId));
}

function getUserFavorites(userId) {
  if (!userId) return { favorite_ids: [], items: [] };
  const uid = String(userId);
  const items = db.prepare(`
    SELECT s.id, s.uid, s.title, s.performer, s.likes, s.plays
    FROM favorites f
    JOIN songs s ON s.id = f.song_id
    WHERE f.user_id = ?
      AND s.available = 1
      AND (COALESCE(TRIM(s.file_id), '') != '' OR (s.from_chat_id IS NOT NULL AND s.message_id IS NOT NULL))
    ORDER BY f.created_at DESC
  `).all(uid);
  return { favorite_ids: items.map(s => s.id), items };
}

function isSongFavorited(userId, songId) {
  return Boolean(db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND song_id = ?').get(String(userId), Number(songId)));
}

function toggleFavorite(userId, songId) {
  const uid = String(userId);
  const sid = Number(songId);
  const now = Math.floor(Date.now() / 1000);

  db.prepare('INSERT OR IGNORE INTO users (id, name, username, joined_at) VALUES (?, ?, ?, ?)').run(uid, '', '', now);

  const tx = db.transaction(() => {
    const exists = db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND song_id = ?').get(uid, sid);
    if (exists) {
      db.prepare('DELETE FROM favorites WHERE user_id = ? AND song_id = ?').run(uid, sid);
      db.prepare('UPDATE songs SET likes = MAX(0, COALESCE(likes, 0) - 1) WHERE id = ?').run(sid);
      return false;
    } else {
      db.prepare('INSERT INTO favorites (user_id, song_id, created_at) VALUES (?, ?, ?)').run(uid, sid, now);
      db.prepare('UPDATE songs SET likes = COALESCE(likes, 0) + 1 WHERE id = ?').run(sid);
      return true;
    }
  });

  const liked = tx();
  const song = db.prepare('SELECT likes FROM songs WHERE id = ?').get(sid);
  const favIds = db.prepare('SELECT song_id FROM favorites WHERE user_id = ?').all(uid).map(r => r.song_id);
  return { liked, likes: song ? song.likes : 0, favorites: favIds };
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

// موتور جستجوی هوشمند دوزبانه با سرعت بالای FTS5 در SQLite
function smartSearchSongs(rawQuery, { onlyWithFileId = false, limit = 200 } = {}) {
  const normQ = normalizeText(rawQuery);
  if (!normQ) return [];

  const expandedQ = expandBilingualTerms(normQ);
  const rawTokens = normQ.split(' ').filter(Boolean);
  const qTokens = Array.from(new Set(expandedQ.split(' ').filter(t => t.length >= 2)));
  const searchTokens = qTokens.length ? qTokens : rawTokens;

  const extraFileWhere = onlyWithFileId ? " AND COALESCE(TRIM(s.file_id), '') != ''" : '';
  let candidates = [];

  try {
    const ftsQuery = searchTokens
      .slice(0, 12)
      .map(t => `"${t.replace(/"/g, '')}"*`)
      .join(' OR ');

    if (ftsQuery) {
      candidates = db.prepare(`
        SELECT s.*
        FROM songs_fts f
        JOIN songs s ON s.id = f.id
        WHERE songs_fts MATCH ?
          AND s.available = 1
          AND (COALESCE(TRIM(s.file_id), '') != '' OR (s.from_chat_id IS NOT NULL AND s.message_id IS NOT NULL))
          ${extraFileWhere}
        LIMIT 300
      `).all(ftsQuery);
    }
  } catch (e) {
    candidates = [];
  }

  if (!candidates.length && searchTokens.length) {
    const likeTokens = searchTokens.slice(0, 8);
    const whereOr = likeTokens.map(() => 'search_text LIKE ?').join(' OR ');
    const params = likeTokens.map(t => `%${t}%`);
    candidates = db.prepare(`
      SELECT * FROM songs
      WHERE ${ACTIVE_WHERE} ${onlyWithFileId ? "AND COALESCE(TRIM(file_id), '') != ''" : ''}
        AND (${whereOr})
      LIMIT 300
    `).all(...params);
  }

  const scored = [];
  for (const s of candidates) {
    const sText = (s.search_text || '').toLowerCase();
    const titlePerformer = normalizeText(`${s.title} ${s.performer}`);
    let score = 0;

    if (rawTokens.every(t => titlePerformer.includes(t))) {
      score += 150;
    } else if (rawTokens.every(t => sText.includes(t))) {
      score += 100;
    }

    const matchedCount = searchTokens.filter(t => sText.includes(t)).length;
    score += matchedCount * 10;

    if (score > 0) {
      scored.push({ song: s, score });
    }
  }

  scored.sort((a, b) => (b.score - a.score) || ((b.song.plays || 0) - (a.song.plays || 0)) || (b.song.id - a.song.id));
  return scored.slice(0, limit).map(x => x.song);
}

// ثبت درخواست موزیک در SQLite و ارسال فوری به پی‌وی ادمین
async function submitSongRequest(userId, userName, queryText) {
  const cleanQ = String(queryText || '').trim();
  if (!cleanQ) return null;

  const uid = String(userId);
  const normQ = normalizeText(cleanQ);
  const pendingByUser = db.prepare("SELECT * FROM requests WHERE user_id = ? AND status = 'pending'").all(uid);
  const existing = pendingByUser.find(r => normalizeText(r.query) === normQ);
  if (existing) return existing;

  const savedUser = getUserById(uid);
  const finalName = userName || savedUser?.name || 'کاربر';
  const expanded = expandBilingualTerms(cleanQ);
  const now = Math.floor(Date.now() / 1000);

  const info = db.prepare(`
    INSERT INTO requests (user_id, user_name, query, expanded_query, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(uid, finalName, cleanQ, expanded, now);

  const reqObj = {
    id: info.lastInsertRowid,
    user_id: uid,
    user_name: finalName,
    query: cleanQ,
    expanded_query: expanded,
    status: 'pending',
    created_at: now
  };

  const adminMsg =
    `📩 **درخواست موزیک جدید از مینی‌اپ/ربات**\n\n` +
    `🎵 آهنگ درخواستی: **${cleanQ}**\n` +
    `👤 درخواست‌کننده: ${reqObj.user_name} (\`${userId}\`)\n` +
    `🆔 کد درخواست: #${reqObj.id}\n\n` +
    `💡 به محض اینکه فایل این آهنگ را در پی‌وی ربات آپلود کنید، به صورت خودکار به کاربر اطلاع داده می‌شود!`;

  for (const adm of ADMIN_IDS) {
    axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: adm,
      text: adminMsg,
      parse_mode: 'Markdown'
    }).catch(() => {});
  }

  return reqObj;
}

// بررسی و اطلاع‌رسانی خودکار به کاربرانی که این آهنگ را درخواست داده بودند
async function notifyFulfilledRequests(song) {
  const pending = db.prepare("SELECT * FROM requests WHERE status = 'pending'").all();
  if (!pending.length) return;

  const songSearch = song.search_text || expandBilingualTerms(`${song.title} ${song.performer}`);
  const updateReq = db.prepare(`
    UPDATE requests SET status = 'fulfilled', fulfilled_song_id = ?, fulfilled_at = ? WHERE id = ?
  `);

  for (const req of pending) {
    const reqExpanded = req.expanded_query || expandBilingualTerms(req.query);
    const tokens = reqExpanded.split(' ').filter(t => t.length >= 2);
    if (!tokens.length) continue;

    const isMatch = tokens.some(t => songSearch.includes(t));
    if (isMatch && req.user_id) {
      updateReq.run(song.id, Math.floor(Date.now() / 1000), req.id);

      const notifyText =
        `🎉 **خبر خوش! موزیک درخواستی شما آماده شد**\n\n` +
        `🎵 خواننده: **${song.performer}**\n` +
        `🎧 نام آهنگ: **${song.title}**\n` +
        `📌 کد موزیک: #${song.id}\n\n` +
        `👇 همین الان دریافت کنید یا در مینی‌اپ بشنوید:`;

      const buttons = [
        [{ text: '📥 دریافت فایل موزیک', callback_data: `dl_${song.id}` }]
      ];
      if (MINI_APP_URL.startsWith('https://')) {
        buttons.push([{ text: '🎧 پخش آنلاین در مینی‌اپ', web_app: { url: MINI_APP_URL } }]);
      }

      axios.post(`${TELEGRAM_API}/sendMessage`, {
        chat_id: req.user_id,
        text: notifyText,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: buttons }
      }).catch(() => {});
    }
  }
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
        db.prepare("UPDATE songs SET file_id = '' WHERE id = ?").run(song.id);
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
          db.prepare('UPDATE songs SET file_id = ?, from_chat_id = ? WHERE id = ?')
            .run(song.file_id, song.from_chat_id, song.id);

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

async function sendAutoDeleteReply(ctx, text, delayMs = 5000) {
  try {
    const sent = await ctx.reply(text);
    setTimeout(() => {
      ctx.telegram.deleteMessage(ctx.chat.id, sent.message_id).catch(() => {});
    }, delayMs);
  } catch (e) {}
}

console.log(`✅ دیتابیس SQLite متصل شد (${DB_PATH}) | موزیک‌های فعال: ${getActiveSongsCount()} | کاربران: ${getUsersCount()}`);

// ---------------------------------------------------------------------------
// سرور وب Express و API های مینی‌اپ
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
  const savedUser = getUserById(userId);
  res.json({
    bot_username: BOT_USERNAME,
    total_songs: getActiveSongsCount(),
    total_users: getUsersCount(),
    total_requests: getRequestsCount(),
    is_admin: isAdmin(userId),
    user_name: savedUser?.name || ''
  });
});

app.get('/api/avatar/:userId', async (req, res) => {
  const uid = req.params.userId;
  if (!uid || uid === 'undefined') return res.status(404).end();

  try {
    const photosResp = await axios.get(`${TELEGRAM_API}/getUserProfilePhotos`, {
      params: { user_id: uid, limit: 1 },
      timeout: 8000
    });
    const photos = photosResp.data?.result?.photos;
    if (!photos || !photos.length || !photos[0].length) return res.status(404).end();

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
  const rawQ = String(req.query.q || '').trim();
  const filter = req.query.filter || 'all';
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 60));

  if (rawQ) {
    const found = smartSearchSongs(rawQ, { limit: 300 });
    const total = found.length;
    const items = found.slice(offset, offset + limit).map(s => ({
      uid: s.uid,
      id: s.id,
      title: s.title,
      performer: s.performer,
      likes: s.likes || 0,
      plays: s.plays || 0
    }));
    return res.json({ total, offset, limit, has_more: offset + items.length < total, items });
  }

  const { total, items } = getSongsPage(filter, offset, limit);
  res.json({ total, offset, limit, has_more: offset + items.length < total, items });
});

app.post('/api/request', async (req, res) => {
  const queryText = String(req.body?.query || '').trim();
  const userId = resolveUserId(req.body?.init_data, req.body?.user_id);
  const userName = String(req.body?.user_name || '').trim();

  if (!queryText) return res.status(400).json({ detail: 'لطفاً نام آهنگ را وارد کنید.' });
  if (!userId) return res.status(400).json({ detail: 'برای ثبت درخواست، مینی‌اپ را از داخل تلگرام باز کنید.' });

  registerUser({ id: userId, first_name: userName });
  const created = await submitSongRequest(userId, userName, queryText);
  res.json({ status: 'ok', request: created });
});

app.delete('/api/admin/song/:id', (req, res) => {
  const userId = resolveUserId(req.body?.init_data || req.query.init_data, req.body?.user_id || req.query.user_id);
  if (!isAdmin(userId)) {
    return res.status(403).json({ detail: 'دسترسی غیرمجاز! فقط ادمین اجازه حذف دارد.' });
  }

  const songId = parseInt(req.params.id, 10);
  const removed = deleteSongById(songId);
  if (!removed) return res.status(404).json({ detail: 'موزیک یافت نشد یا قبلاً حذف شده است.' });

  res.json({
    status: 'ok',
    deleted: removed,
    remaining: getActiveSongsCount()
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
  res.json(getUserFavorites(userId));
});

app.post('/api/favorite/:id', (req, res) => {
  const songId = parseInt(req.params.id, 10);
  const userId = resolveUserId(req.body.init_data, req.body.user_id);
  if (!userId) return res.status(400).json({ error: 'User ID required' });

  const result = toggleFavorite(userId, songId);
  res.json({ status: 'ok', ...result });
});

app.get('/api/random', (req, res) => {
  const s = getRandomActiveSong();
  if (!s) return res.status(404).json({ detail: 'آهنگی یافت نشد' });
  res.json({
    uid: s.uid,
    id: s.id,
    title: s.title,
    performer: s.performer,
    likes: s.likes || 0
  });
});

app.get('/api/stream/:uid', async (req, res) => {
  const song = getActiveSongByUidOrId(req.params.uid);
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

    if (!req.headers.range || req.headers.range.startsWith('bytes=0-')) {
      incrementSongPlays(song.id);
    }

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
  const song = getActiveSongByUidOrId(req.params.uid);
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

// جلوگیری از کرش شدن ربات در صورت بروز خطاهای تلگرام
bot.catch((err, ctx) => {
  console.error(`⚠️ خطا در پردازش ${ctx.updateType}:`, err.message);
});

function buildMainMenu(userId) {
  const activeCount = getActiveSongsCount();
  const favCount = db.prepare('SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?').get(String(userId)).c;

  const text =
    `سلام! 👋 به ربات و پلیر هوشمند **GapMusic** خوش آمدید.\n\n` +
    `🎼 آرشیو موزیک‌های فعال: **${activeCount}** ترک 🎵\n` +
    `❤️ پلی‌لیست شخصی شما: **${favCount}** موزیک\n` +
    `📤 هر موزیکی که بفرستید به صورت خودکار به آرشیو اضافه می‌شود!\n\n` +
    `💡 نام خواننده یا آهنگ را به فارسی یا انگلیسی تایپ کنید:`;

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
    Markup.button.switchToCurrentChat('⚡ سرچ آنی (Inline)', '.'),
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
    const icon = (s.plays || 0) >= 10 ? '🔥' : '🎵';
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
  incrementSongPlays(song.id);
  const updatedPlays = (song.plays || 0) + 1;

  const liked = isSongFavorited(userId, song.id);
  const likeBtnText = liked ? `❤️ در پلی‌لیست (${song.likes || 0})` : `🤍 افزودن به پلی‌لیست (${song.likes || 0})`;

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

  const caption = `🎵 ${song.performer} - ${song.title}\n▶️ دریافت: ${updatedPlays} مرتبه | 🆔 #${song.id}`;
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
    const song = getSongById(songId);

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
    `🛡️ **پنل مدیریت ادمین GapMusic (SQLite)**\n\n` +
    `🎵 کل موزیک‌های فعال: **${getActiveSongsCount()}**\n` +
    `👥 تعداد کاربران: **${getUsersCount()}**\n` +
    `📩 درخواست‌های در انتظار: **${getRequestsCount(true)}** (کل: ${getRequestsCount()})\n\n` +
    `📌 **روش‌های حذف آهنگ:**\n` +
    `1️⃣ داخل مینی‌اپ، روی دکمه 🗑️ کنار هر آهنگ بزنید.\n` +
    `2️⃣ دستور \`/del کد_آهنگ\` را بفرستید (مثلاً: \`/del 125\`).`;

  await ctx.replyWithMarkdown(msg, Markup.inlineKeyboard([
    [Markup.button.webApp('🛡️ ورود به پنل مدیریتی در مینی‌اپ', MINI_APP_URL)],
    [Markup.button.callback('📦 دریافت بکاپ دیتابیس SQLite', 'admin_export')]
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
    `🛡️ **پنل مدیریت ادمین GapMusic (SQLite)**\n\n` +
    `🎵 کل موزیک‌های فعال: **${getActiveSongsCount()}**\n` +
    `👥 تعداد کاربران: **${getUsersCount()}**\n` +
    `📩 درخواست‌های در انتظار: **${getRequestsCount(true)}**\n\n` +
    `💡 برای حذف سریع: دستور \`/del کد_آهنگ\` را بفرستید یا در مینی‌اپ آیکون 🗑️ را بزنید.`;

  await ctx.editMessageText(msg, {
    parse_mode: 'Markdown',
    ...Markup.inlineKeyboard([
      [Markup.button.webApp('🛡️ مدیریت و حذف در مینی‌اپ', MINI_APP_URL)],
      [Markup.button.callback('📦 دریافت بکاپ دیتابیس SQLite', 'admin_export')],
      [Markup.button.callback('🔙 منوی اصلی', 'main_menu')]
    ])
  }).catch(() => {});
  await ctx.answerCbQuery();
});

async function sendDbBackup(ctx) {
  const backupPath = path.join(path.dirname(DB_PATH), `backup_${Date.now()}.db`);
  try {
    await db.backup(backupPath);
    await ctx.replyWithDocument(
      { source: backupPath, filename: 'gapmusic.db' },
      { caption: `📦 بکاپ کامل دیتابیس SQLite | کل آهنگ‌های فعال: ${getActiveSongsCount()}` }
    );
  } catch (e) {
    if (fs.existsSync(DB_PATH)) {
      await ctx.replyWithDocument(
        { source: DB_PATH, filename: 'gapmusic.db' },
        { caption: `📦 فایل دیتابیس SQLite | کل آهنگ‌های فعال: ${getActiveSongsCount()}` }
      );
    }
  } finally {
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
  }
}

bot.action('admin_export', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery();
  await ctx.answerCbQuery('📦 در حال تهیه بکاپ...');
  await sendDbBackup(ctx);
});

bot.command('export_db', async (ctx) => {
  if (!isAdmin(ctx.from.id)) return;
  await sendDbBackup(ctx);
});

bot.action(/^admdel_(\d+)$/, async (ctx) => {
  if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery('فقط ادمین اجازه حذف دارد!', { show_alert: true });
  const songId = parseInt(ctx.match[1], 10);
  const removed = deleteSongById(songId);
  if (!removed) return ctx.answerCbQuery('قبلاً حذف شده است.', { show_alert: true });
  await ctx.answerCbQuery(`🗑️ آهنگ #${songId} حذف شد!`, { show_alert: true });
  await ctx.deleteMessage().catch(() => {});
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
  const { total, items } = getSongsPage('all', 0, 120);
  userSessions.set(ctx.from.id, { list: items.map(s => s.id) });
  await ctx.editMessageText(`🎵 کل موزیک‌های فعال (${total} ترک | ۱۲۰ ترک اخیر):`, buildSongListKeyboard(items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('top_songs', async (ctx) => {
  const { items } = getSongsPage('popular', 0, 60);
  userSessions.set(ctx.from.id, { list: items.map(s => s.id) });
  await ctx.editMessageText('🔥 پرطرفدارترین موزیک‌ها:', buildSongListKeyboard(items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('newest_songs', async (ctx) => {
  const { items } = getSongsPage('all', 0, 60);
  userSessions.set(ctx.from.id, { list: items.map(s => s.id) });
  await ctx.editMessageText('🆕 جدیدترین موزیک‌های آرشیو:', buildSongListKeyboard(items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('my_favorites', async (ctx) => {
  const { items } = getUserFavorites(ctx.from.id);
  if (!items.length) {
    return ctx.answerCbQuery('پلی‌لیست شما خالی است! زیر آهنگ‌ها روی 🤍 بزنید.', { show_alert: true });
  }
  userSessions.set(ctx.from.id, { list: items.map(s => s.id) });
  await ctx.editMessageText(`❤️ پلی‌لیست شخصی شما (${items.length} ترک):`, buildSongListKeyboard(items, 0)).catch(() => {});
  await ctx.answerCbQuery();
});

bot.action('random_song', async (ctx) => {
  const song = getRandomActiveSong();
  if (!song) return ctx.answerCbQuery('آهنگی یافت نشد', { show_alert: true });
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
  const song = getActiveSongByUidOrId(songId);
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
  const songs = getSongsByIds(session.list);
  await ctx.editMessageReplyMarkup(buildSongListKeyboard(songs, page).reply_markup).catch(() => {});
  await ctx.answerCbQuery();
});

// دریافت فایل صوتی و ذخیره مستقیم در SQLite
bot.on(['audio', 'document', 'channel_post'], async (ctx, next) => {
  const msg = ctx.message || ctx.channelPost;
  if (!msg) return next();

  const audio = msg.audio || (msg.document && (msg.document.mime_type || '').startsWith('audio/') ? msg.document : null);
  if (!audio) return next();

  if (ctx.from) registerUser(ctx.from);

  const rawTitle = audio.title || (audio.file_name ? path.parse(audio.file_name).name : 'نامشخص');
  const title = cleanDisplayText(rawTitle);
  const performer = cleanDisplayText(audio.performer || 'نامشخص');
  const normSearch = expandBilingualTerms(`${title} ${performer}`);
  const fileUniqueId = audio.file_unique_id || '';
  const mediaType = msg.audio ? 'audio' : 'document';

  let exists = null;
  if (fileUniqueId) {
    exists = db.prepare('SELECT * FROM songs WHERE file_unique_id = ? LIMIT 1').get(fileUniqueId);
  }
  if (!exists && normSearch.length > 3) {
    exists = db.prepare('SELECT * FROM songs WHERE search_text = ? LIMIT 1').get(normSearch);
  }

  if (exists) {
    db.prepare(`
      UPDATE songs
      SET file_id = ?, file_unique_id = ?, from_chat_id = ?, message_id = ?, media_type = ?, available = 1
      WHERE id = ?
    `).run(audio.file_id, fileUniqueId || exists.file_unique_id, String(ctx.chat.id), msg.message_id, mediaType, exists.id);

    const updated = getSongById(exists.id);
    notifyFulfilledRequests(updated).catch(() => {});

    if (!ctx.channelPost) {
      const dupMsg =
        `⚠️ این موزیک قبلاً در دیتابیس ثبت شده بود و بروزرسانی شد!\n\n` +
        `🎵 خواننده: ${exists.performer}\n` +
        `🎧 نام آهنگ: ${exists.title}\n` +
        `📌 کد ثبت شده: ${exists.id}`;
      await sendAutoDeleteReply(ctx, dupMsg, 5000);
    }
    return;
  }

  const maxRow = db.prepare('SELECT COALESCE(MAX(id), 0) AS maxId FROM songs').get();
  const newId = maxRow.maxId + 1;
  const uid = `${newId}_${msg.message_id}`;

  db.prepare(`
    INSERT INTO songs (id, uid, from_chat_id, message_id, file_id, file_unique_id, title, performer, search_text, media_type, plays, likes, available)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1)
  `).run(newId, uid, String(ctx.chat.id), msg.message_id, audio.file_id, fileUniqueId, title, performer, normSearch, mediaType);

  const newSong = getSongById(newId);
  notifyFulfilledRequests(newSong).catch(() => {});

  if (!ctx.channelPost) {
    const confirmMsg =
      `✅ موزیک با موفقیت در دیتابیس SQLite ذخیره شد!\n\n` +
      `🎵 خواننده: ${performer}\n` +
      `🎧 نام آهنگ: ${title}\n` +
      `📌 کد ثبت شده: ${newId}`;

    await sendAutoDeleteReply(ctx, confirmMsg, 5000);
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
    await submitSongRequest(ctx.from.id, ctx.from.first_name, query);
    await ctx.reply(`✅ درخواست شما برای «${query}» ثبت شد و به ادمین ارسال گردید.\nبه محض آپلود، در پی‌وی به شما خبر می‌دهم!`);
    return;
  }

  const results = smartSearchSongs(query, { limit: 100 });

  if (!results.length) {
    userSessions.set(ctx.from.id, { pendingQuery: query });
    return ctx.reply(
      `❌ آهنگی برای «${query}» یافت نشد.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📩 ارسال درخواست برای ادمین', 'quick_request_pending')],
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

bot.action('quick_request_pending', async (ctx) => {
  const session = userSessions.get(ctx.from.id);
  const q = session?.pendingQuery;
  if (!q) return ctx.answerCbQuery('لطفاً دوباره نام آهنگ را تایپ کنید.', { show_alert: true });
  userSessions.delete(ctx.from.id);
  await submitSongRequest(ctx.from.id, ctx.from.first_name, q);
  await ctx.editMessageText(`✅ درخواست شما برای «${q}» به ادمین ارسال شد.\nبه محض آپلود شدن آهنگ، در پی‌وی به شما خبر می‌دهم!`).catch(() => {});
  await ctx.answerCbQuery('✅ درخواست ثبت شد!');
});

// سرچ آنی (Inline) با بررسی معتبر بودن file_id و حالت پشتیبان بدون کرش
bot.on('inline_query', async (ctx) => {
  const rawQ = (ctx.inlineQuery.query || '').trim();
  let songs = [];

  if (rawQ && rawQ !== '.') {
    songs = smartSearchSongs(rawQ, { onlyWithFileId: true, limit: 25 });
  } else {
    songs = db.prepare(`
      SELECT * FROM songs
      WHERE available = 1
        AND media_type = 'audio'
        AND file_id LIKE 'CQAC%'
      ORDER BY id DESC
      LIMIT 25
    `).all();
  }

  const audioSongs = songs.filter(s => s.file_id && s.file_id.startsWith('CQAC'));

  const audioResults = audioSongs.map(s => ({
    type: 'audio',
    id: `aud_${s.id}`,
    audio_file_id: s.file_id,
    caption: `🎵 ${s.performer} - ${s.title}`
  }));

  try {
    if (audioResults.length > 0) {
      await ctx.answerInlineQuery(audioResults, { cache_time: 5, is_personal: true });
      return;
    }
  } catch (err) {
    console.error('⚠️ Inline Audio Error (Fallback to article):', err.message);
  }

  const fallbackSongs = songs.length
    ? songs.slice(0, 25)
    : getSongsPage('all', 0, 25).items;

  const articleResults = fallbackSongs.map(s => {
    const deepLink = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}?start=song_${s.id}` : MINI_APP_URL;
    return {
      type: 'article',
      id: `art_${s.id}`,
      title: `${s.title}`,
      description: `${s.performer}`,
      input_message_content: {
        message_text: `🎵 **${s.performer} - ${s.title}**\n🎧 GapMusic`,
        parse_mode: 'Markdown'
      },
      reply_markup: {
        inline_keyboard: [
          [{ text: '📥 دریافت فایل از ربات', url: deepLink }]
        ]
      }
    };
  });

  try {
    await ctx.answerInlineQuery(articleResults, { cache_time: 5, is_personal: true });
  } catch (e) {
    console.error('⚠️ Inline Fallback Error:', e.message);
  }
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
          text: 'Mini App',
          web_app: { url: MINI_APP_URL }
        }
      });
    } catch (e) {}
  }

  bot.launch({ dropPendingUpdates: true })
    .then(() => console.log('🤖 ربات تلگرام آنلاین شد!'))
    .catch((err) => console.error('⚠️ خطا در اتصال ربات:', err.message));
});

process.once('SIGINT', () => { bot.stop('SIGINT'); db.close(); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); db.close(); });
