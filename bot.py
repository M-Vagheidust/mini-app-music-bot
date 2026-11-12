# -*- coding: utf-8 -*-
"""
Telegram Music Bot (Pro Edition)
Python: 3.10+ (Fully compatible with Python 3.14)
Library: python-telegram-bot 22.8

Databases:
- songs_db.json (Songs & Metadata)
- users_db.json (Users, Favorites & Requests)
"""

import asyncio
import json
import logging
import os
import random
import re
import sys
import time
from collections import Counter
from difflib import SequenceMatcher
from logging.handlers import RotatingFileHandler
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from telegram import (
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InlineQueryResultCachedAudio,
    InputFile,
    Update,
    WebAppInfo,
    MenuButtonWebApp,
    constants,
)
from telegram.error import BadRequest, Forbidden, RetryAfter, TelegramError
from telegram.ext import (
    Application,
    ApplicationBuilder,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    InlineQueryHandler,
    MessageHandler,
    filters,
)

# ---------------------------------------------------------------------------
# تنظیمات اصلی
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent
DB_FILE = BASE_DIR / "songs_db.json"
USERS_DB_FILE = BASE_DIR / "users_db.json"
LOG_FILE = BASE_DIR / "bot_errors.log"

# توکن ربات (خواندن از متغیر محیطی Railway با مقدار پیش‌فرض)
BOT_TOKEN = os.getenv("BOT_TOKEN", "8973013935:AAE9N-n3I8jKWg9TWu_wmZICZDaeD6zzFbw")

# آدرس HTTPS مینی‌اپ در Railway (در تب Variables تنظیم می‌شود)
MINI_APP_URL = os.getenv("MINI_APP_URL", "")

# آیدی عددی ادمین‌ها
ADMIN_IDS: List[int] = [849152312]

GROUP_URL = "https://t.me/+k1KWTCq0FMswZjM0"
CONFIRM_DELETE_SECONDS = 5
PAGE_SIZE = 6
ARTISTS_PAGE_SIZE = 8
MAX_INLINE_RESULTS = 25
RATE_LIMIT_SECONDS = 1.2  # فاصله مجاز بین درخواست‌های دانلود هر کاربر

# خالی باشد: ذخیره خودکار از همه چت‌هایی که ربات در آن‌ها پیام دریافت می‌کند.
ALLOWED_CHAT_IDS: List[int] = []

# ---------------------------------------------------------------------------
# لاگ‌گیری
# ---------------------------------------------------------------------------

logger = logging.getLogger("musicbot")
logger.setLevel(logging.INFO)
logger.handlers.clear()

_log_format = logging.Formatter("%(asctime)s | %(levelname)s | %(message)s")

_file_handler = RotatingFileHandler(
    LOG_FILE,
    maxBytes=2 * 1024 * 1024,
    backupCount=3,
    encoding="utf-8",
)
_file_handler.setFormatter(_log_format)

_console_handler = logging.StreamHandler(sys.stdout)
_console_handler.setFormatter(_log_format)

logger.addHandler(_file_handler)
logger.addHandler(_console_handler)

# ---------------------------------------------------------------------------
# کش دیتابیس‌ها و وضعیت‌ها
# ---------------------------------------------------------------------------

ALL_SONGS_CACHE: List[Dict[str, Any]] = []
SONGS_CACHE: List[Dict[str, Any]] = []
DB_MTIME: Optional[float] = None

USERS_CACHE: Dict[str, Any] = {"users": {}, "requests": []}
USERS_DB_MTIME: Optional[float] = None

USER_LAST_ACTION: Dict[int, float] = {}


def is_admin(user_id: Optional[int]) -> bool:
    if user_id is None:
        return False
    return user_id in ADMIN_IDS


def check_rate_limit(user_id: int) -> bool:
    """بررسی ضد اسپم؛ اگر کاربر بیش از حد سریع کلیک کند False برمی‌گرداند."""
    if is_admin(user_id):
        return True
    now = time.monotonic()
    last = USER_LAST_ACTION.get(user_id, 0.0)
    if now - last < RATE_LIMIT_SECONDS:
        return False
    USER_LAST_ACTION[user_id] = now
    return True


# ---------------------------------------------------------------------------
# پردازش متن و نرمال‌سازی
# ---------------------------------------------------------------------------

def normalize_text(value: Any) -> str:
    """یکسان‌سازی متن فارسی/انگلیسی برای جستجو."""
    if value is None:
        return ""

    text = str(value).lower()
    replacements = {
        "ي": "ی",
        "ك": "ک",
        "آ": "ا",
        "أ": "ا",
        "إ": "ا",
        "ۀ": "ه",
        "ة": "ه",
        "ؤ": "و",
        "ئ": "ی",
        "‌": " ",
        "\u200c": " ",
        "_": " ",
        "-": " ",
        ".": " ",
        "/": " ",
        "\\": " ",
    }

    for old, new in replacements.items():
        text = text.replace(old, new)

    text = re.sub(r"[^\w\s]", " ", text, flags=re.UNICODE)
    return " ".join(text.split())


def is_playable(song: Dict[str, Any]) -> bool:
    """رکورد فقط وقتی قابل ارسال است که فایل یا پیام منبع داشته باشد."""
    has_file = bool(str(song.get("file_id") or "").strip())
    has_source = (
        song.get("from_chat_id") is not None
        and song.get("message_id") is not None
    )
    return has_file or has_source


def _normalize_song(item: Dict[str, Any], fallback_id: int) -> Dict[str, Any]:
    title = str(item.get("title") or item.get("name") or "نامشخص").strip() or "نامشخص"
    performer = str(
        item.get("performer") or item.get("artist") or "نامشخص"
    ).strip() or "نامشخص"

    try:
        song_id = int(item.get("id", fallback_id))
    except (TypeError, ValueError):
        song_id = fallback_id

    source_chat = (
        item.get("from_chat_id")
        if item.get("from_chat_id") is not None
        else item.get("chat_id")
    )
    message_id = item.get("message_id")

    try:
        if source_chat is not None:
            source_chat = int(source_chat)
    except (TypeError, ValueError):
        source_chat = None

    try:
        if message_id is not None:
            message_id = int(message_id)
    except (TypeError, ValueError):
        message_id = None

    file_id = str(item.get("file_id") or "").strip()
    file_unique_id = str(item.get("file_unique_id") or "").strip()
    media_type = str(item.get("media_type") or "unknown").strip().lower()

    try:
        plays = max(0, int(item.get("plays", 0)))
    except (TypeError, ValueError):
        plays = 0

    try:
        likes = max(0, int(item.get("likes", 0)))
    except (TypeError, ValueError):
        likes = 0

    search_text = normalize_text(
        f"{title} {performer} {item.get('search_text') or ''}"
    )

    song = {
        "id": song_id,
        "from_chat_id": source_chat,
        "message_id": message_id,
        "file_id": file_id,
        "file_unique_id": file_unique_id,
        "title": title,
        "performer": performer,
        "search_text": search_text,
        "media_type": media_type,
        "plays": plays,
        "likes": likes,
    }

    song["available"] = bool(item.get("available", is_playable(song)))
    if "available" not in item:
        song["available"] = is_playable(song)

    return song


# ---------------------------------------------------------------------------
# مدیریت دیتابیس موزیک‌ها (songs_db.json)
# ---------------------------------------------------------------------------

def load_all_songs(force: bool = False) -> List[Dict[str, Any]]:
    """خواندن امن دیتابیس و نگهداری همه رکوردها در حافظه."""
    global ALL_SONGS_CACHE, SONGS_CACHE, DB_MTIME

    try:
        mtime = DB_FILE.stat().st_mtime if DB_FILE.exists() else None
    except OSError:
        mtime = None

    if not force and ALL_SONGS_CACHE and mtime == DB_MTIME:
        return ALL_SONGS_CACHE

    if not DB_FILE.exists():
        logger.warning("فایل دیتابیس پیدا نشد: %s", DB_FILE)
        ALL_SONGS_CACHE = []
        SONGS_CACHE = []
        DB_MTIME = None
        return ALL_SONGS_CACHE

    try:
        with DB_FILE.open("r", encoding="utf-8-sig") as file:
            data = json.load(file)

        if isinstance(data, list):
            raw_items = data
        elif isinstance(data, dict):
            raw_items = data.get("songs", data.get("messages", []))
        else:
            raw_items = []

        normalized: List[Dict[str, Any]] = []
        seen_ids = set()

        for index, item in enumerate(raw_items, start=1):
            if not isinstance(item, dict):
                continue

            song = _normalize_song(item, index)

            if song["id"] in seen_ids:
                song["id"] = max(seen_ids, default=0) + 1
            seen_ids.add(song["id"])

            normalized.append(song)

        ALL_SONGS_CACHE = normalized
        SONGS_CACHE = [
            song for song in ALL_SONGS_CACHE
            if song.get("available", False) and is_playable(song)
        ]
        DB_MTIME = mtime

        logger.info(
            "Database loaded: total=%s | playable=%s | unavailable=%s",
            len(ALL_SONGS_CACHE),
            len(SONGS_CACHE),
            len(ALL_SONGS_CACHE) - len(SONGS_CACHE),
        )
        return ALL_SONGS_CACHE

    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("خطا در خواندن دیتابیس: %s", exc)
        ALL_SONGS_CACHE = []
        SONGS_CACHE = []
        return ALL_SONGS_CACHE


def load_songs(force: bool = False) -> List[Dict[str, Any]]:
    """فقط آهنگ‌های قابل ارسال را برمی‌گرداند."""
    load_all_songs(force=force)
    return SONGS_CACHE


def save_all_songs(songs: List[Dict[str, Any]]) -> bool:
    """ذخیره اتمیک دیتابیس؛ فایل اصلی در زمان نوشتن ناقص نمی‌شود."""
    global ALL_SONGS_CACHE, SONGS_CACHE, DB_MTIME

    temp_file = DB_FILE.with_suffix(DB_FILE.suffix + ".tmp")

    try:
        DB_FILE.parent.mkdir(parents=True, exist_ok=True)

        with temp_file.open("w", encoding="utf-8") as file:
            json.dump(songs, file, ensure_ascii=False, indent=2)
            file.flush()
            os.fsync(file.fileno())

        os.replace(temp_file, DB_FILE)

        ALL_SONGS_CACHE = songs
        SONGS_CACHE = [
            song for song in ALL_SONGS_CACHE
            if song.get("available", False) and is_playable(song)
        ]
        DB_MTIME = DB_FILE.stat().st_mtime
        return True

    except Exception:
        logger.exception("ذخیره دیتابیس ناموفق بود.")
        try:
            if temp_file.exists():
                temp_file.unlink()
        except OSError:
            pass
        return False


def save_songs_async() -> None:
    """ذخیره غیرمسدودکننده دیتابیس موزیک در پس‌زمینه."""
    try:
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, save_all_songs, ALL_SONGS_CACHE)
    except RuntimeError:
        save_all_songs(ALL_SONGS_CACHE)


# ---------------------------------------------------------------------------
# مدیریت دیتابیس کاربران و پلی‌لیست‌ها (users_db.json)
# ---------------------------------------------------------------------------

def load_users_db() -> Dict[str, Any]:
    global USERS_CACHE, USERS_DB_MTIME

    try:
        mtime = USERS_DB_FILE.stat().st_mtime if USERS_DB_FILE.exists() else None
    except OSError:
        mtime = None

    if USERS_DB_MTIME is not None and mtime == USERS_DB_MTIME:
        return USERS_CACHE

    if not USERS_DB_FILE.exists():
        USERS_CACHE = {"users": {}, "requests": []}
        USERS_DB_MTIME = None
        return USERS_CACHE

    try:
        with USERS_DB_FILE.open("r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                data.setdefault("users", {})
                data.setdefault("requests", [])
                USERS_CACHE = data
                USERS_DB_MTIME = mtime
    except Exception:
        logger.exception("خطا در خواندن دیتابیس کاربران")

    return USERS_CACHE


def save_users_db() -> bool:
    global USERS_DB_MTIME
    temp_file = USERS_DB_FILE.with_suffix(".json.tmp")
    try:
        with temp_file.open("w", encoding="utf-8") as f:
            json.dump(USERS_CACHE, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_file, USERS_DB_FILE)
        USERS_DB_MTIME = USERS_DB_FILE.stat().st_mtime
        return True
    except Exception:
        logger.exception("خطا در ذخیره دیتابیس کاربران")
        return False


def save_users_async() -> None:
    try:
        loop = asyncio.get_running_loop()
        loop.run_in_executor(None, save_users_db)
    except RuntimeError:
        save_users_db()


def register_user(user) -> Dict[str, Any]:
    """ثبت یا بروزرسانی اطلاعات کاربر در دیتابیس."""
    if user is None:
        return {}
    db = load_users_db()
    uid = str(user.id)
    if uid not in db["users"]:
        db["users"][uid] = {
            "id": user.id,
            "name": user.full_name or "",
            "username": user.username or "",
            "favorites": [],
            "joined_at": int(time.time()),
        }
        save_users_async()
    else:
        u_record = db["users"][uid]
        if u_record.get("name") != (user.full_name or "") or u_record.get("username") != (user.username or ""):
            u_record["name"] = user.full_name or ""
            u_record["username"] = user.username or ""
            save_users_async()
    return db["users"][uid]


def toggle_favorite(user_id: int, song_id: int) -> Tuple[bool, int]:
    """افزودن یا حذف آهنگ از پلی‌لیست کاربر. خروجی: (وضعیت فعلی، کل لایک‌های آهنگ)"""
    db = load_users_db()
    uid = str(user_id)
    if uid not in db["users"]:
        db["users"][uid] = {
            "id": user_id,
            "name": "",
            "username": "",
            "favorites": [],
            "joined_at": int(time.time()),
        }

    favs: List[int] = db["users"][uid].setdefault("favorites", [])
    all_songs = load_all_songs()
    target_song = next((s for s in all_songs if s["id"] == song_id), None)

    if song_id in favs:
        favs.remove(song_id)
        is_liked = False
        if target_song:
            target_song["likes"] = max(0, target_song.get("likes", 1) - 1)
    else:
        favs.append(song_id)
        is_liked = True
        if target_song:
            target_song["likes"] = target_song.get("likes", 0) + 1

    save_users_async()
    if target_song:
        save_songs_async()
        return is_liked, target_song.get("likes", 0)
    return is_liked, 0


def is_song_liked_by(user_id: int, song_id: int) -> bool:
    db = load_users_db()
    user_data = db["users"].get(str(user_id), {})
    return song_id in user_data.get("favorites", [])


# ---------------------------------------------------------------------------
# موتور جستجوی هوشمند + فازی (Fuzzy Search)
# ---------------------------------------------------------------------------

def advanced_search(
    query: str,
    songs: Optional[List[Dict[str, Any]]] = None,
    limit: Optional[int] = None,
) -> List[Dict[str, Any]]:
    normalized_query = normalize_text(query)
    if not normalized_query:
        return []

    if songs is None:
        songs = load_songs()

    tokens = normalized_query.split()
    scored: List[Tuple[float, Dict[str, Any]]] = []

    for song in songs:
        searchable = song.get("search_text") or normalize_text(
            f"{song.get('title', '')} {song.get('performer', '')}"
        )

        matched_tokens = sum(1 for token in tokens if token in searchable)
        score = 0.0

        if matched_tokens > 0:
            score += matched_tokens * 12.0
            if normalized_query in searchable:
                score += 20.0

            title_artist = normalize_text(
                f"{song.get('title', '')} {song.get('performer', '')}"
            )
            if normalized_query == title_artist:
                score += 35.0
        else:
            ratio = SequenceMatcher(None, normalized_query, searchable).ratio()
            if ratio >= 0.58:
                score += ratio * 15.0
            else:
                continue

        plays_bonus = min(5.0, (song.get("plays", 0) * 0.1))
        scored.append((score + plays_bonus, song))

    scored.sort(key=lambda item: item[0], reverse=True)
    results = [song for _, song in scored]

    if limit is not None:
        return results[:limit]
    return results


def get_artists_list(songs: Optional[List[Dict[str, Any]]] = None) -> List[Tuple[str, int]]:
    """استخراج لیست خوانندگان به همراه تعداد آهنگ‌های هرکدام."""
    if songs is None:
        songs = load_songs()

    counter: Counter = Counter()
    for s in songs:
        performer = str(s.get("performer") or "نامشخص").strip()
        if performer and performer not in ("نامشخص", "ناشناس", "unknown"):
            counter[performer] += 1

    return counter.most_common()


# ---------------------------------------------------------------------------
# استخراج و ذخیره خودکار آهنگ
# ---------------------------------------------------------------------------

def extract_audio_info(message) -> Optional[Dict[str, str]]:
    if message is None:
        return None

    audio = message.audio
    if audio:
        file_name = audio.file_name or ""
        title = audio.title or os.path.splitext(file_name)[0] or "نامشخص"
        return {
            "file_id": audio.file_id,
            "file_unique_id": audio.file_unique_id,
            "title": str(title).strip() or "نامشخص",
            "performer": str(audio.performer or "نامشخص").strip(),
            "media_type": "audio",
        }

    document = message.document
    if document:
        mime_type = (document.mime_type or "").lower()
        file_name = document.file_name or ""
        extension = Path(file_name).suffix.lower()

        audio_extensions = {
            ".mp3", ".m4a", ".aac", ".flac", ".ogg",
            ".opus", ".wav", ".wma", ".aiff", ".alac",
        }

        if mime_type.startswith("audio/") or extension in audio_extensions:
            title = os.path.splitext(file_name)[0] or "نامشخص"
            return {
                "file_id": document.file_id,
                "file_unique_id": document.file_unique_id,
                "title": title.strip() or "نامشخص",
                "performer": "نامشخص",
                "media_type": "document",
            }

    return None


def add_song_if_new(
    info: Dict[str, str],
    chat_id: int,
    message_id: int,
) -> Tuple[Dict[str, Any], bool]:
    all_songs = load_all_songs()

    for song in all_songs:
        same_unique = (
            bool(info.get("file_unique_id"))
            and song.get("file_unique_id") == info["file_unique_id"]
        )
        same_file = (
            bool(info.get("file_id"))
            and song.get("file_id") == info["file_id"]
        )
        same_message = (
            song.get("from_chat_id") == chat_id
            and song.get("message_id") == message_id
        )

        if same_unique or same_file or same_message:
            changed = False
            for key in ("file_id", "file_unique_id", "title", "performer", "media_type"):
                if info.get(key) and (not song.get(key) or song.get(key) == "نامشخص"):
                    song[key] = info[key]
                    changed = True

            if changed:
                song["search_text"] = normalize_text(
                    f"{song.get('title', '')} {song.get('performer', '')}"
                )

            if not song.get("available", False) and is_playable(song):
                song["available"] = True
                changed = True

            if changed:
                save_all_songs(all_songs)

            return song, False

    new_id = max((int(song.get("id", 0)) for song in all_songs), default=0) + 1

    new_song = {
        "id": new_id,
        "from_chat_id": int(chat_id),
        "message_id": int(message_id),
        "file_id": info["file_id"],
        "file_unique_id": info["file_unique_id"],
        "title": info["title"],
        "performer": info["performer"],
        "search_text": normalize_text(f"{info['title']} {info['performer']}"),
        "media_type": info.get("media_type", "unknown"),
        "plays": 0,
        "likes": 0,
        "available": True,
    }

    all_songs.append(new_song)
    save_all_songs(all_songs)
    return new_song, True


async def delete_later(message, seconds: int) -> None:
    await asyncio.sleep(seconds)
    try:
        await message.delete()
    except TelegramError:
        pass


async def auto_save_audio_handler(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    try:
        message = update.effective_message
        chat = update.effective_chat

        if message is None or chat is None:
            return

        if ALLOWED_CHAT_IDS and chat.id not in ALLOWED_CHAT_IDS:
            return

        info = extract_audio_info(message)
        if not info:
            return

        song, is_new = add_song_if_new(
            info=info,
            chat_id=chat.id,
            message_id=message.message_id,
        )

        if chat.type == constants.ChatType.CHANNEL:
            return

        if is_new:
            reply = (
                "✅ موزیک با موفقیت در دیتابیس ذخیره شد!\n\n"
                f"🎵 خواننده: {song['performer']}\n"
                f"🎧 نام آهنگ: {song['title']}\n"
                f"📌 کد ثبت شده: {song['id']}"
            )
        else:
            reply = (
                "⚠️ این آهنگ قبلاً در دیتابیس ثبت شده است.\n"
                f"📌 کد آهنگ: {song['id']}"
            )

        confirmation = await message.reply_text(reply)
        asyncio.create_task(delete_later(confirmation, CONFIRM_DELETE_SECONDS))

    except Exception:
        logger.exception("خطا در ذخیره خودکار موزیک")


# ---------------------------------------------------------------------------
# ارسال آهنگ و کنترلر پلیر
# ---------------------------------------------------------------------------

def song_caption(song: Dict[str, Any]) -> str:
    performer = str(song.get("performer") or "ناشناس").strip()
    title = str(song.get("title") or "بدون عنوان").strip()
    plays = song.get("plays", 0)
    return (
        f"🎵 {performer} - {title}\n"
        f"▶️ دریافت: {plays} مرتبه | 🆔 #{song.get('id')}"
    )[:1024]


def build_song_control_keyboard(
    song: Dict[str, Any],
    user_id: Optional[int] = None,
) -> InlineKeyboardMarkup:
    song_id = song["id"]
    liked = is_song_liked_by(user_id, song_id) if user_id else False
    likes_count = song.get("likes", 0)
    heart_icon = "❤️" if liked else "🤍"
    like_label = f"{heart_icon} پسندیدن ({likes_count})" if likes_count else f"{heart_icon} افزودن به پلی‌لیست"

    performer = str(song.get("performer") or "").strip()

    buttons = [
        [
            InlineKeyboardButton(like_label, callback_data=f"like_{song_id}"),
            InlineKeyboardButton("🎲 آهنگ بعدی", callback_data="random_song"),
        ]
    ]

    second_row = []
    if performer and performer not in ("نامشخص", "ناشناس"):
        second_row.append(
            InlineKeyboardButton(
                f"🎤 آثار {performer[:20]}",
                callback_data=f"same_art_{song_id}",
            )
        )
    second_row.append(
        InlineKeyboardButton(
            "📤 اشتراک‌گذاری",
            switch_inline_query=f"{performer} {song.get('title', '')}".strip()[:40],
        )
    )
    buttons.append(second_row)

    if MINI_APP_URL.startswith("https://"):
        buttons.append([
            InlineKeyboardButton("🎧 باز کردن مینی‌اپ GapMusic", web_app=WebAppInfo(url=MINI_APP_URL))
        ])

    return InlineKeyboardMarkup(buttons)


async def send_song(
    context: ContextTypes.DEFAULT_TYPE,
    chat_id: int,
    song: Dict[str, Any],
    user_id: Optional[int] = None,
    show_caption: bool = True,
    with_controls: bool = True,
) -> bool:
    song["plays"] = song.get("plays", 0) + 1
    caption = song_caption(song) if show_caption else ""
    reply_markup = build_song_control_keyboard(song, user_id) if with_controls else None

    source_chat_id = song.get("from_chat_id")
    source_message_id = song.get("message_id")

    if source_chat_id is not None and source_message_id is not None:
        try:
            await context.bot.copy_message(
                chat_id=chat_id,
                from_chat_id=int(source_chat_id),
                message_id=int(source_message_id),
                caption=caption,
                parse_mode=None,
                reply_markup=reply_markup,
            )
            save_songs_async()
            return True
        except TelegramError as exc:
            logger.warning(
                "copy_message ناموفق بود؛ fallback به file_id. song_id=%s error=%s",
                song.get("id"),
                exc,
            )
            if "not found" in str(exc).lower() or "invalid" in str(exc).lower():
                song["message_id"] = None

    file_id = str(song.get("file_id") or "").strip()

    if not file_id and song.get("message_id") is None:
        logger.warning("موزیک %s فاقد سورس و file_id است. از نتایج حذف شد.", song.get("id"))
        global ALL_SONGS_CACHE, SONGS_CACHE
        song["available"] = False
        SONGS_CACHE = [s for s in ALL_SONGS_CACHE if s.get("available", False) and is_playable(s)]
        save_songs_async()
        return False

    try:
        await context.bot.send_audio(
            chat_id=chat_id,
            audio=file_id,
            caption=caption,
            parse_mode=None,
            reply_markup=reply_markup,
        )
        save_songs_async()
        return True
    except TelegramError as audio_error:
        logger.warning(
            "send_audio ناموفق بود؛ تلاش با send_document. song_id=%s error=%s",
            song.get("id"),
            audio_error,
        )

    try:
        await context.bot.send_document(
            chat_id=chat_id,
            document=file_id,
            caption=caption,
            parse_mode=None,
            reply_markup=reply_markup,
        )
        save_songs_async()
        return True
    except TelegramError:
        logger.exception("ارسال فایل ناموفق بود. song_id=%s", song.get("id"))
        song["available"] = False
        SONGS_CACHE = [s for s in ALL_SONGS_CACHE if s.get("available", False) and is_playable(s)]
        save_songs_async()
        return False


# ---------------------------------------------------------------------------
# کیبوردها و منوها
# ---------------------------------------------------------------------------

def build_pagination_keyboard(
    songs: List[Dict[str, Any]],
    page: int = 0,
    per_page: int = PAGE_SIZE,
) -> InlineKeyboardMarkup:
    total = len(songs)
    total_pages = max(1, (total + per_page - 1) // per_page)
    page = max(0, min(page, total_pages - 1))

    start = page * per_page
    page_items = songs[start:start + per_page]

    keyboard = []

    for song in page_items:
        plays = song.get("plays", 0)
        fire = "🔥 " if plays >= 10 else "🎵 "
        label = f"{fire}{song.get('performer', 'ناشناس')} - {song.get('title', 'بدون عنوان')}"
        keyboard.append([
            InlineKeyboardButton(
                label[:60],
                callback_data=f"dl_{song['id']}",
            )
        ])

    navigation = []
    if page > 0:
        navigation.append(
            InlineKeyboardButton("◀️ قبلی", callback_data=f"page_{page - 1}")
        )

    navigation.append(
        InlineKeyboardButton(
            f"📄 {page + 1} از {total_pages}",
            callback_data="noop",
        )
    )

    if page < total_pages - 1:
        navigation.append(
            InlineKeyboardButton("بعدی ▶️", callback_data=f"page_{page + 1}")
        )

    keyboard.append(navigation)

    if MINI_APP_URL.startswith("https://"):
        keyboard.append([
            InlineKeyboardButton("🎧 باز کردن مینی‌اپ (پخش آنلاین)", web_app=WebAppInfo(url=MINI_APP_URL))
        ])

    keyboard.append([
        InlineKeyboardButton("🎲 موزیک شانسی", callback_data="random_song"),
        InlineKeyboardButton(
            "🔍 سرچ آنلاین (Inline)",
            switch_inline_query_current_chat="",
        ),
    ])

    keyboard.append([
        InlineKeyboardButton("🔙 بازگشت به منوی اصلی", callback_data="main_menu"),
    ])

    return InlineKeyboardMarkup(keyboard)


def build_artists_keyboard(
    artists: List[Tuple[str, int]],
    page: int = 0,
    per_page: int = ARTISTS_PAGE_SIZE,
) -> InlineKeyboardMarkup:
    total = len(artists)
    total_pages = max(1, (total + per_page - 1) // per_page)
    page = max(0, min(page, total_pages - 1))

    start = page * per_page
    page_items = artists[start:start + per_page]

    keyboard = []
    row = []
    for idx, (artist_name, count) in enumerate(page_items, start=start):
        row.append(
            InlineKeyboardButton(
                f"🎤 {artist_name[:22]} ({count})",
                callback_data=f"art_{idx}",
            )
        )
        if len(row) == 2:
            keyboard.append(row)
            row = []
    if row:
        keyboard.append(row)

    nav = []
    if page > 0:
        nav.append(InlineKeyboardButton("◀️ قبلی", callback_data=f"artpage_{page - 1}"))
    nav.append(InlineKeyboardButton(f"📄 {page + 1} از {total_pages}", callback_data="noop"))
    if page < total_pages - 1:
        nav.append(InlineKeyboardButton("بعدی ▶️", callback_data=f"artpage_{page + 1}"))
    keyboard.append(nav)

    keyboard.append([
        InlineKeyboardButton("🔙 بازگشت به منوی اصلی", callback_data="main_menu")
    ])
    return InlineKeyboardMarkup(keyboard)


def main_menu_content(user_id: Optional[int] = None) -> Tuple[str, InlineKeyboardMarkup]:
    songs = load_songs()
    fav_count = 0
    if user_id:
        db = load_users_db()
        fav_count = len(db["users"].get(str(user_id), {}).get("favorites", []))

    text = (
        "سلام! 👋 به ربات هوشمند موزیک خوش آمدید.\n\n"
        f"🎼 آرشیو موزیک‌های فعال: {len(songs)} ترک 🎵\n"
        f"❤️ پلی‌لیست شخصی شما: {fav_count} موزیک\n\n"
        "💡 نام خواننده یا آهنگ مورد نظر خود را مستقیماً تایپ و ارسال کنید یا از دکمه‌های زیر کمک بگیرید:"
    )

    keyboard = []
    if MINI_APP_URL.startswith("https://"):
        keyboard.append([
            InlineKeyboardButton("🎧 ورود به مینی‌اپ GapMusic (پخش آنلاین)", web_app=WebAppInfo(url=MINI_APP_URL))
        ])

    keyboard.extend([
        [
            InlineKeyboardButton("🎵 کل موزیک‌ها", callback_data="list_all_songs"),
            InlineKeyboardButton("🎲 موزیک شانسی", callback_data="random_song"),
        ],
        [
            InlineKeyboardButton("🔥 پرطرفدارترین‌ها", callback_data="top_songs"),
            InlineKeyboardButton("🆕 جدیدترین‌ها", callback_data="newest_songs"),
        ],
        [
            InlineKeyboardButton("🎤 لیست خوانندگان", callback_data="list_artists"),
            InlineKeyboardButton(f"❤️ پلی‌لیست من ({fav_count})", callback_data="my_favorites"),
        ],
        [
            InlineKeyboardButton("🔍 راهنمای سرچ", callback_data="prompt_search"),
            InlineKeyboardButton("⚡ سرچ آنی (Inline)", switch_inline_query_current_chat=""),
        ],
        [
            InlineKeyboardButton("📩 درخواست موزیک", callback_data="request_song"),
            InlineKeyboardButton("🌐 گپ ما", url=GROUP_URL),
        ],
    ])

    if is_admin(user_id):
        keyboard.append([
            InlineKeyboardButton("🛠️ پنل مدیریت ادمین", callback_data="admin_panel")
        ])

    return text, InlineKeyboardMarkup(keyboard)


# ---------------------------------------------------------------------------
# دستورات و هندلرها
# ---------------------------------------------------------------------------

async def post_init(application: Application) -> None:
    """تنظیم دکمه دائمی مینی‌اپ در کنار کادر تایپ تلگرام (Menu Button)"""
    if MINI_APP_URL.startswith("https://"):
        try:
            await application.bot.set_chat_menu_button(
                menu_button=MenuButtonWebApp(
                    text="🎧 پلیر GapMusic",
                    web_app=WebAppInfo(url=MINI_APP_URL)
                )
            )
            logger.info("دکمه منوی تلگرام (MenuButtonWebApp) با موفقیت تنظیم شد: %s", MINI_APP_URL)
        except Exception as e:
            logger.warning("امکان تنظیم MenuButtonWebApp نبود: %s", e)


async def start_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    if update.effective_chat is None or update.effective_user is None:
        return

    register_user(update.effective_user)
    context.user_data.pop("awaiting_request", None)
    context.user_data.pop("awaiting_broadcast", None)

    if update.effective_chat.type != constants.ChatType.PRIVATE:
        return

    if context.args and context.args[0].startswith("dl_"):
        try:
            song_id = int(context.args[0][3:])
            song = next((s for s in load_songs() if s["id"] == song_id), None)
            if song:
                await send_song(
                    context=context,
                    chat_id=update.effective_chat.id,
                    song=song,
                    user_id=update.effective_user.id,
                )
                return
        except ValueError:
            pass

    text, markup = main_menu_content(update.effective_user.id)
    await update.effective_message.reply_text(text, reply_markup=markup)


async def admin_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    user = update.effective_user
    if not user or not is_admin(user.id):
        return

    text, markup = build_admin_panel_view()
    await update.effective_message.reply_text(text, reply_markup=markup)


async def edit_song_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    user = update.effective_user
    if not user or not is_admin(user.id):
        return

    raw = update.effective_message.text or ""
    parts = raw.split(maxsplit=2)
    if len(parts) < 3 or "|" not in parts[2]:
        await update.effective_message.reply_text(
            "✏️ فرمت صحیح ویرایش:\n"
            "`/edit 125 شادمهر عقیلی | تقدیر`",
            parse_mode=constants.ParseMode.MARKDOWN,
        )
        return

    try:
        song_id = int(parts[1])
    except ValueError:
        await update.effective_message.reply_text("❌ کد آهنگ باید عدد باشد.")
        return

    performer, title = [p.strip() for p in parts[2].split("|", 1)]
    all_songs = load_all_songs()
    target = next((s for s in all_songs if s["id"] == song_id), None)

    if not target:
        await update.effective_message.reply_text("❌ آهنگی با این کد یافت نشد.")
        return

    target["performer"] = performer or target["performer"]
    target["title"] = title or target["title"]
    target["search_text"] = normalize_text(f"{target['title']} {target['performer']}")
    save_all_songs(all_songs)

    await update.effective_message.reply_text(
        f"✅ موزیک #{song_id} بروزرسانی شد:\n"
        f"🎤 خواننده: {target['performer']}\n"
        f"🎵 عنوان: {target['title']}"
    )


async def delete_song_command(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    user = update.effective_user
    if not user or not is_admin(user.id):
        return

    if not context.args:
        await update.effective_message.reply_text("🗑️ مثال: `/del 125`", parse_mode=constants.ParseMode.MARKDOWN)
        return

    try:
        song_id = int(context.args[0])
    except ValueError:
        await update.effective_message.reply_text("❌ کد آهنگ نامعتبر است.")
        return

    all_songs = load_all_songs()
    target = next((s for s in all_songs if s["id"] == song_id), None)
    if not target:
        await update.effective_message.reply_text("❌ آهنگی با این کد یافت نشد.")
        return

    target["available"] = False
    save_all_songs(all_songs)
    await update.effective_message.reply_text(f"🗑️ موزیک #{song_id} ({target['title']}) از لیست پخش حذف شد.")


def build_admin_panel_view() -> Tuple[str, InlineKeyboardMarkup]:
    all_songs = load_all_songs()
    playable = load_songs()
    db = load_users_db()
    total_users = len(db.get("users", {}))
    pending_reqs = len([r for r in db.get("requests", []) if r.get("status") == "pending"])
    total_plays = sum(s.get("plays", 0) for s in all_songs)

    text = (
        "🛠️ **داشبورد مدیریت ربات موزیک**\n\n"
        f"📦 کل رکوردهای دیتابیس: `{len(all_songs)}`\n"
        f"✅ موزیک‌های سالم و فعال: `{len(playable)}`\n"
        f"⚠️ موزیک‌های غیرفعال/حذف‌شده: `{len(all_songs) - len(playable)}`\n"
        f"👥 تعداد کاربران ثبت‌شده: `{total_users}`\n"
        f"▶️ مجموع کل دانلودها: `{total_plays}`\n"
        f"📩 درخواست‌های در انتظار: `{pending_reqs}`\n\n"
        "✏️ ویرایش سریع: `/edit کد خواننده | نام آهنگ`\n"
        "🗑️ حذف سریع: `/del کد`"
    )

    keyboard = [
        [
            InlineKeyboardButton("📦 دریافت بکاپ دیتابیس", callback_data="adm_backup"),
            InlineKeyboardButton("🔄 ریلود دیتابیس از دیسک", callback_data="adm_reload"),
        ],
        [
            InlineKeyboardButton(f"📩 مشاهده درخواست‌ها ({pending_reqs})", callback_data="adm_requests"),
            InlineKeyboardButton("📢 ارسال پیام همگانی", callback_data="adm_broadcast"),
        ],
        [
            InlineKeyboardButton("🔙 بازگشت به منوی اصلی", callback_data="main_menu"),
        ],
    ]
    return text, InlineKeyboardMarkup(keyboard)


async def search_handler(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    message = update.effective_message
    user = update.effective_user
    chat = update.effective_chat
    if message is None or not message.text or chat is None:
        return

    register_user(user)
    text_in = message.text.strip()
    if not text_in or text_in.startswith("/"):
        return

    if chat.type != constants.ChatType.PRIVATE:
        if text_in.startswith("موزیک "):
            query_text = text_in[6:].strip()
            if not query_text:
                return
        else:
            return
    else:
        query_text = text_in

    if chat.type == constants.ChatType.PRIVATE and context.user_data.get("awaiting_broadcast") and is_admin(user.id):
        context.user_data.pop("awaiting_broadcast", None)
        db = load_users_db()
        user_ids = list(db.get("users", {}).keys())
        status_msg = await message.reply_text(f"⏳ در حال ارسال پیام به {len(user_ids)} کاربر...")

        sent = 0
        failed = 0
        for uid in user_ids:
            try:
                await context.bot.send_message(chat_id=int(uid), text=query_text)
                sent += 1
                await asyncio.sleep(0.05)
            except RetryAfter as e:
                await asyncio.sleep(e.retry_after)
            except (Forbidden, TelegramError):
                failed += 1

        await status_msg.edit_text(
            f"✅ ارسال همگانی به پایان رسید!\n"
            f"📬 موفق: {sent} نفر\n"
            f"❌ ناموفق/بلاک: {failed} نفر"
        )
        return

    if chat.type == constants.ChatType.PRIVATE and context.user_data.get("awaiting_request"):
        context.user_data.pop("awaiting_request", None)
        db = load_users_db()
        req_id = len(db["requests"]) + 1
        req_obj = {
            "id": req_id,
            "user_id": user.id,
            "user_name": user.full_name or "",
            "query": query_text[:200],
            "status": "pending",
            "created_at": int(time.time()),
        }
        db["requests"].append(req_obj)
        save_users_async()

        await message.reply_text(
            "✅ درخواست موزیک شما با موفقیت ثبت شد!\n"
            f"🎵 عنوان درخواستی: «{query_text}»\n"
            "به محض قرار گرفتن در آرشیو به شما اطلاع می‌دهیم."
        )

        for admin_id in ADMIN_IDS:
            try:
                adm_kb = InlineKeyboardMarkup([
                    [
                        InlineKeyboardButton(
                            "✅ اضافه شد (اطلاع به کاربر)",
                            callback_data=f"reqdone_{req_id}",
                        )
                    ]
                ])
                await context.bot.send_message(
                    chat_id=admin_id,
                    text=(
                        f"📩 **درخواست موزیک جدید #{req_id}**\n"
                        f"👤 کاربر: {user.full_name} (`{user.id}`)\n"
                        f"🎵 درخواست: `{query_text}`"
                    ),
                    parse_mode=constants.ParseMode.MARKDOWN,
                    reply_markup=adm_kb,
                )
            except TelegramError:
                pass
        return

    results = advanced_search(query_text)

    if not results:
        no_res_kb = InlineKeyboardMarkup([
            [
                InlineKeyboardButton(
                    "📩 ثبت درخواست این موزیک",
                    callback_data=f"quickreq_{query_text[:35]}",
                )
            ],
            [
                InlineKeyboardButton("🎲 موزیک شانسی", callback_data="random_song"),
                InlineKeyboardButton("🔙 منوی اصلی", callback_data="main_menu"),
            ],
        ])
        await message.reply_text(
            f"❌ آهنگی با مشخصات «{query_text}» در دیتابیس یافت نشد.\n\n"
            "💡 می‌توانید با کلیک روی دکمه زیر درخواست دهید تا ادمین‌ها آن را اضافه کنند:",
            reply_markup=no_res_kb,
        )
        return

    context.user_data["active_result_ids"] = [song["id"] for song in results]

    markup = build_pagination_keyboard(results, page=0)
    await message.reply_text(
        f"🔍 نتایج جستجو برای: «{query_text}»\n"
        f"✅ تعداد یافت‌شده: {len(results)} موزیک",
        reply_markup=markup,
    )


async def inline_search_handler(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    inline_query = update.inline_query
    if inline_query is None:
        return

    query_text = inline_query.query.strip()
    songs = load_songs()

    if query_text:
        candidates = advanced_search(query_text, songs)
    else:
        candidates = sorted(
            songs,
            key=lambda s: (s.get("plays", 0), s.get("id", 0)),
            reverse=True,
        )

    audio_songs = [
        song for song in candidates
        if song.get("media_type") == "audio" and song.get("file_id")
    ][:MAX_INLINE_RESULTS]

    results = []
    for song in audio_songs:
        results.append(
            InlineQueryResultCachedAudio(
                id=str(song["id"]),
                audio_file_id=song["file_id"],
                caption=song_caption(song),
            )
        )

    await inline_query.answer(
        results,
        cache_time=5,
        is_personal=True,
    )


# ---------------------------------------------------------------------------
# مدیریت دکمه‌های شیشه‌ای (Callback Query)
# ---------------------------------------------------------------------------

async def button_callback(
    update: Update,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    query = update.callback_query
    user = update.effective_user
    if query is None or user is None:
        return

    register_user(user)
    data = query.data or ""

    try:
        if data == "noop":
            await query.answer()
            return

        if data == "main_menu":
            context.user_data.pop("awaiting_request", None)
            context.user_data.pop("awaiting_broadcast", None)
            text, markup = main_menu_content(user.id)
            await query.edit_message_text(text, reply_markup=markup)
            await query.answer()
            return

        if data == "prompt_search":
            rows = []
            if MINI_APP_URL.startswith("https://"):
                rows.append([InlineKeyboardButton("🎧 جستجو و پخش آنلاین در مینی‌اپ", web_app=WebAppInfo(url=MINI_APP_URL))])
            rows.append([InlineKeyboardButton("⚡ سرچ آنی لحظه‌ای", switch_inline_query_current_chat="")])
            rows.append([InlineKeyboardButton("🔙 بازگشت به منوی اصلی", callback_data="main_menu")])

            await query.edit_message_text(
                "🔍 **راهنمای جستجوی هوشمند:**\n\n"
                "۱. نام خواننده یا آهنگ را در همین چت ارسال کنید.\n"
                "۲. در گروه‌ها می‌توانید بنویسید: `موزیک شادمهر`\n"
                "۳. یا با دکمه‌های زیر جستجو را شروع کنید:",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(rows),
            )
            await query.answer()
            return

        if data == "list_all_songs":
            songs = load_songs()
            if not songs:
                await query.answer("موزیکی در دیتابیس موجود نیست.", show_alert=True)
                return

            context.user_data["active_result_ids"] = [song["id"] for song in songs]
            markup = build_pagination_keyboard(songs, page=0)
            await query.edit_message_text(
                f"🎵 لیست کل موزیک‌های قابل دریافت (تعداد کل: {len(songs)}):",
                reply_markup=markup,
            )
            await query.answer()
            return

        if data == "top_songs":
            songs = load_songs()
            if not songs:
                await query.answer("موزیکی در دیتابیس موجود نیست.", show_alert=True)
                return

            top_list = sorted(
                songs,
                key=lambda s: (s.get("plays", 0), s.get("likes", 0), s.get("id", 0)),
                reverse=True,
            )[:60]
            context.user_data["active_result_ids"] = [s["id"] for s in top_list]
            markup = build_pagination_keyboard(top_list, page=0)
            await query.edit_message_text(
                "🔥 **پرطرفدارترین موزیک‌های ربات** (بر اساس تعداد دریافت و لایک):",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data == "newest_songs":
            songs = load_songs()
            if not songs:
                await query.answer("موزیکی در دیتابیس موجود نیست.", show_alert=True)
                return

            newest_list = sorted(songs, key=lambda s: s.get("id", 0), reverse=True)[:60]
            context.user_data["active_result_ids"] = [s["id"] for s in newest_list]
            markup = build_pagination_keyboard(newest_list, page=0)
            await query.edit_message_text(
                "🆕 **جدیدترین موزیک‌های اضافه‌شده به آرشیو:**",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data == "my_favorites":
            db = load_users_db()
            fav_ids = db["users"].get(str(user.id), {}).get("favorites", [])
            if not fav_ids:
                await query.answer(
                    "پلی‌لیست شما هنوز خالی است! زیر هر آهنگی که دوست داشتید روی 🤍 بزنید تا اینجا ذخیره شود.",
                    show_alert=True,
                )
                return

            all_playable = {s["id"]: s for s in load_songs()}
            fav_songs = [all_playable[sid] for sid in reversed(fav_ids) if sid in all_playable]

            if not fav_songs:
                await query.answer("آهنگ‌های ذخیره‌شده دیگر در دسترس نیستند.", show_alert=True)
                return

            context.user_data["active_result_ids"] = [s["id"] for s in fav_songs]
            markup = build_pagination_keyboard(fav_songs, page=0)
            await query.edit_message_text(
                f"❤️ **پلی‌لیست شخصی شما** ({len(fav_songs)} موزیک):",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data == "list_artists" or data.startswith("artpage_"):
            artists = get_artists_list()
            if not artists:
                await query.answer("لیست خوانندگان خالی است.", show_alert=True)
                return

            page = 0
            if data.startswith("artpage_"):
                try:
                    page = int(data.split("_", 1)[1])
                except ValueError:
                    page = 0

            markup = build_artists_keyboard(artists, page=page)
            await query.edit_message_text(
                f"🎤 **آرشیو خوانندگان** (تعداد کل: {len(artists)} خواننده):\n"
                "روی نام خواننده مورد نظر کلیک کنید:",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data.startswith("art_"):
            try:
                idx = int(data.split("_", 1)[1])
                artists = get_artists_list()
                artist_name, _ = artists[idx]
            except (ValueError, IndexError):
                await query.answer("خواننده یافت نشد.", show_alert=True)
                return

            artist_songs = [
                s for s in load_songs()
                if str(s.get("performer") or "").strip() == artist_name
            ]
            context.user_data["active_result_ids"] = [s["id"] for s in artist_songs]
            markup = build_pagination_keyboard(artist_songs, page=0)
            await query.edit_message_text(
                f"🎤 لیست آثار **{artist_name}** ({len(artist_songs)} موزیک):",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data.startswith("same_art_"):
            try:
                song_id = int(data.split("_")[2])
            except (ValueError, IndexError):
                return

            ref_song = next((s for s in load_songs() if s["id"] == song_id), None)
            if not ref_song:
                await query.answer("اطلاعات خواننده یافت نشد.", show_alert=True)
                return

            performer = str(ref_song.get("performer") or "").strip()
            artist_songs = [
                s for s in load_songs()
                if normalize_text(s.get("performer")) == normalize_text(performer)
            ]
            context.user_data["active_result_ids"] = [s["id"] for s in artist_songs]
            markup = build_pagination_keyboard(artist_songs, page=0)
            await query.message.reply_text(
                f"🎤 آثار موجود از **{performer}** ({len(artist_songs)} موزیک):",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data.startswith("like_"):
            try:
                song_id = int(data.split("_", 1)[1])
            except ValueError:
                return

            is_liked, total_likes = toggle_favorite(user.id, song_id)
            song = next((s for s in load_all_songs() if s["id"] == song_id), None)
            if song and query.message:
                new_kb = build_song_control_keyboard(song, user.id)
                try:
                    await query.edit_message_reply_markup(reply_markup=new_kb)
                except TelegramError:
                    pass

            msg = "❤️ به پلی‌لیست شخصی شما اضافه شد!" if is_liked else "💔 از پلی‌لیست شما حذف شد."
            await query.answer(msg)
            return

        if data == "request_song":
            context.user_data["awaiting_request"] = True
            kb = InlineKeyboardMarkup([
                [InlineKeyboardButton("🔙 انصراف و بازگشت", callback_data="main_menu")]
            ])
            await query.edit_message_text(
                "📩 **فرم درخواست موزیک**\n\n"
                "لطفاً نام آهنگ و نام خواننده مورد نظر خود را در یک پیام بنویسید و ارسال کنید:",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=kb,
            )
            await query.answer()
            return

        if data.startswith("quickreq_"):
            req_title = data.split("_", 1)[1]
            db = load_users_db()
            req_id = len(db["requests"]) + 1
            db["requests"].append({
                "id": req_id,
                "user_id": user.id,
                "user_name": user.full_name or "",
                "query": req_title,
                "status": "pending",
                "created_at": int(time.time()),
            })
            save_users_async()
            await query.answer("✅ درخواست شما برای ادمین ارسال شد!", show_alert=True)

            for admin_id in ADMIN_IDS:
                try:
                    adm_kb = InlineKeyboardMarkup([
                        [InlineKeyboardButton("✅ اضافه شد (اطلاع به کاربر)", callback_data=f"reqdone_{req_id}")]
                    ])
                    await context.bot.send_message(
                        chat_id=admin_id,
                        text=f"📩 درخواست سریع #{req_id} از {user.full_name}:\n🎵 `{req_title}`",
                        parse_mode=constants.ParseMode.MARKDOWN,
                        reply_markup=adm_kb,
                    )
                except TelegramError:
                    pass
            return

        # --- بخش مدیریت ادمین ---
        if data == "admin_panel" and is_admin(user.id):
            text, markup = build_admin_panel_view()
            await query.edit_message_text(
                text,
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer()
            return

        if data == "adm_reload" and is_admin(user.id):
            load_all_songs(force=True)
            text, markup = build_admin_panel_view()
            await query.edit_message_text(
                text,
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=markup,
            )
            await query.answer("✅ دیتابیس با موفقیت از روی هارد بازخوانی شد!", show_alert=True)
            return

        if data == "adm_backup" and is_admin(user.id):
            if DB_FILE.exists():
                with DB_FILE.open("rb") as f:
                    await context.bot.send_document(
                        chat_id=user.id,
                        document=InputFile(f, filename="songs_db_backup.json"),
                        caption=f"📦 بکاپ دیتابیس موزیک‌ها\nتعداد رکورد: {len(load_all_songs())}",
                    )
            await query.answer("فایل بکاپ ارسال شد.")
            return

        if data == "adm_broadcast" and is_admin(user.id):
            context.user_data["awaiting_broadcast"] = True
            kb = InlineKeyboardMarkup([
                [InlineKeyboardButton("🔙 انصراف", callback_data="admin_panel")]
            ])
            await query.edit_message_text(
                "📢 **ارسال پیام همگانی**\n\n"
                "متن پیام خود را ارسال کنید تا برای تمام کاربران ثبت‌شده در ربات ارسال شود:",
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=kb,
            )
            await query.answer()
            return

        if data == "adm_requests" and is_admin(user.id):
            db = load_users_db()
            pending = [r for r in db.get("requests", []) if r.get("status") == "pending"][-10:]
            if not pending:
                await query.answer("هیچ درخواست در انتظاری وجود ندارد!", show_alert=True)
                return

            lines = ["📩 **۱۰ درخواست آخر کاربران:**\n"]
            kb_rows = []
            for r in pending:
                lines.append(f"🔹 `#{r['id']}` | {r['user_name']}: **{r['query']}**")
                kb_rows.append([
                    InlineKeyboardButton(
                        f"✅ انجام شد #{r['id']} ({r['query'][:20]})",
                        callback_data=f"reqdone_{r['id']}",
                    )
                ])
            kb_rows.append([InlineKeyboardButton("🔙 بازگشت به پنل", callback_data="admin_panel")])
            await query.edit_message_text(
                "\n".join(lines),
                parse_mode=constants.ParseMode.MARKDOWN,
                reply_markup=InlineKeyboardMarkup(kb_rows),
            )
            await query.answer()
            return

        if data.startswith("reqdone_") and is_admin(user.id):
            req_id = int(data.split("_", 1)[1])
            db = load_users_db()
            req_item = next((r for r in db.get("requests", []) if r["id"] == req_id), None)
            if req_item:
                req_item["status"] = "done"
                save_users_async()
                try:
                    await context.bot.send_message(
                        chat_id=req_item["user_id"],
                        text=(
                            f"🎉 خبر خوب!\n"
                            f"موزیک درخواستی شما «**{req_item['query']}**» به ربات اضافه شد.\n"
                            "هم‌اکنون می‌توانید نام آن را در ربات جستجو و دانلود کنید!"
                        ),
                        parse_mode=constants.ParseMode.MARKDOWN,
                    )
                except TelegramError:
                    pass
                await query.answer("✅ به کاربر اطلاع داده شد!", show_alert=True)
            return

        # --- دانلود موزیک و موزیک شانسی ---
        if data == "random_song":
            if not check_rate_limit(user.id):
                await query.answer("⏳ لطفاً کمی آهسته‌تر کلیک کنید!", show_alert=False)
                return

            songs = list(load_songs())
            if not songs:
                await query.answer("موزیکی در دیتابیس موجود نیست.", show_alert=True)
                return

            target_chat_id = (
                query.message.chat_id if query.message is not None else user.id
            )

            success = False
            for _ in range(15):
                if not songs:
                    break
                song = random.choice(songs)
                success = await send_song(
                    context=context,
                    chat_id=target_chat_id,
                    song=song,
                    user_id=user.id,
                    show_caption=True,
                )
                if success:
                    break
                songs.remove(song)

            if not success:
                await query.answer(
                    "آهنگ‌های شانسی انتخاب شده از سورس پاک شده بودند. دوباره کلیک کن!",
                    show_alert=True,
                )
            else:
                await query.answer("🎲 موزیک شانسی ارسال شد!")
            return

        if data.startswith("dl_"):
            if not check_rate_limit(user.id):
                await query.answer("⏳ لطفاً ۱ ثانیه صبر کنید...", show_alert=False)
                return

            try:
                song_id = int(data[3:])
            except ValueError:
                await query.answer("شناسه آهنگ نامعتبر است.", show_alert=True)
                return

            song = next((item for item in load_songs() if item["id"] == song_id), None)
            if song is None:
                await query.answer("موزیک مورد نظر در دیتابیس یافت نشد.", show_alert=True)
                return

            target_chat_id = (
                query.message.chat_id if query.message is not None else user.id
            )

            await query.answer("⏳ در حال ارسال موزیک...")
            success = await send_song(
                context=context,
                chat_id=target_chat_id,
                song=song,
                user_id=user.id,
                show_caption=True,
            )

            if not success:
                await query.answer(
                    "ارسال این فایل ممکن نشد؛ پیام منبع یا شناسه فایل در دسترس نیست.",
                    show_alert=True,
                )
            return

        if data.startswith("page_"):
            try:
                page = int(data.split("_", 1)[1])
            except (ValueError, IndexError):
                return

            active_ids = context.user_data.get("active_result_ids", [])
            all_songs = load_songs()
            by_id = {song["id"]: song for song in all_songs}
            results = [by_id[song_id] for song_id in active_ids if song_id in by_id]

            if not results:
                await query.answer(
                    "نتایج منقضی شده‌اند؛ دوباره جستجو کنید.",
                    show_alert=True,
                )
                return

            markup = build_pagination_keyboard(results, page=page)
            await query.edit_message_reply_markup(reply_markup=markup)
            await query.answer()
            return

    except BadRequest as exc:
        if "message is not modified" in str(exc).lower():
            return
        logger.warning("درخواست نامعتبر تلگرام: %s", exc)
    except TelegramError:
        logger.exception("خطای تلگرام در callback")
    except Exception:
        logger.exception("خطای پیش‌بینی‌نشده در callback")


async def error_handler(
    update: object,
    context: ContextTypes.DEFAULT_TYPE,
) -> None:
    logger.error("Unhandled exception while processing update", exc_info=context.error)


# ---------------------------------------------------------------------------
# راه‌اندازی و اجرای ربات
# ---------------------------------------------------------------------------

def build_application() -> Application:
    application = (
        ApplicationBuilder()
        .token(BOT_TOKEN)
        .connect_timeout(20.0)
        .read_timeout(30.0)
        .write_timeout(30.0)
        .pool_timeout(20.0)
        .concurrent_updates(16)
        .post_init(post_init)
        .build()
    )

    application.add_handler(CommandHandler("start", start_command))
    application.add_handler(CommandHandler(["admin", "panel"], admin_command))
    application.add_handler(CommandHandler("edit", edit_song_command))
    application.add_handler(CommandHandler("del", delete_song_command))
    application.add_handler(CallbackQueryHandler(button_callback))
    application.add_handler(InlineQueryHandler(inline_search_handler))

    audio_filter = (
        (filters.UpdateType.MESSAGE | filters.UpdateType.CHANNEL_POST)
        & (filters.AUDIO | filters.Document.AUDIO)
    )
    application.add_handler(MessageHandler(audio_filter, auto_save_audio_handler))

    application.add_handler(
        MessageHandler(
            filters.TEXT & ~filters.COMMAND,
            search_handler,
        )
    )

    application.add_error_handler(error_handler)
    return application


def main() -> None:
    if (
        not BOT_TOKEN
        or BOT_TOKEN.startswith("توکن_")
        or "اینجا_قرار_بده" in BOT_TOKEN
    ):
        logger.critical("توکن ربات تنظیم نشده است؛ مقدار BOT_TOKEN را در کد وارد کن.")
        raise SystemExit(1)

    if sys.platform.startswith("win") and hasattr(asyncio, "WindowsSelectorEventLoopPolicy"):
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    load_all_songs(force=True)
    load_users_db()

    logger.info("در حال راه‌اندازی ربات...")
    application = build_application()

    application.run_polling(
        drop_pending_updates=True,
        allowed_updates=[
            "message",
            "channel_post",
            "callback_query",
            "inline_query",
        ],
    )


if __name__ == "__main__":
    main()
