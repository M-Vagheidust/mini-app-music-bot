import sys
import asyncio

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

import os
import re
import json
import hmac
import hashlib
from contextlib import asynccontextmanager
from urllib.parse import parse_qsl
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse, JSONResponse
import httpx

# همگام‌سازی توکن با bot.py
BOT_TOKEN = os.getenv("BOT_TOKEN", "8973013935:AAE9N-n3I8jKWg9TWu_wmZICZDaeD6zzFbw")
DB_FILE = os.getenv("DB_FILE", "songs_db.json")

TELEGRAM_API = f"https://api.telegram.org/bot{BOT_TOKEN}"
TELEGRAM_FILE_API = f"https://api.telegram.org/file/bot{BOT_TOKEN}"

_DB_CACHE: List[Dict[str, Any]] = []
_DB_MTIME: float = 0.0


@asynccontextmanager
async def lifespan(app: FastAPI):
    """اجرای همزمان ربات تلگرام در کنار سرور مینی‌اپ"""
    from bot import build_application, load_all_songs, load_users_db
    load_all_songs(force=True)
    load_users_db()

    ptb_app = build_application()
    await ptb_app.initialize()
    await ptb_app.start()
    await ptb_app.updater.start_polling(
        drop_pending_updates=True,
        allowed_updates=["message", "channel_post", "callback_query", "inline_query"],
    )
    yield
    await ptb_app.updater.stop()
    await ptb_app.stop()
    await ptb_app.shutdown()


app = FastAPI(title="GapMusic Mini App", lifespan=lifespan)


def normalize_text(text: str) -> str:
    if not text:
        return ""
    text = str(text).lower()
    replacements = {
        'ي': 'ی', 'ك': 'ک', 'آ': 'ا', 'أ': 'ا', 'إ': 'ا',
        '‌': ' ', '\u200c': ' ', '_': ' ', '-': ' ', '.': ' ', '/': ' ', '\\': ' '
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = re.sub(r'[^\w\s]', '', text)
    return " ".join(text.split())


def clean_display_text(text: str) -> str:
    if not text:
        return "نامشخص"
    t = str(text)
    t = re.sub(r'\.(mp3|m4a|ogg|flac|wav)+$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'^\s*\d+\s*[\|\s\-\.]+\d*\s*[\-\._]+\s*', '', t)
    t = re.sub(r'\(\s*(320|128|160)\s*\)', '', t)
    t = re.sub(r'(@\w+|\[.*?\]|~.*)', '', t)
    t = t.replace('_', ' ').strip(' -_|/؛.')
    return t if t else "نامشخص"


def get_songs() -> List[Dict[str, Any]]:
    global _DB_CACHE, _DB_MTIME
    if not os.path.exists(DB_FILE):
        return []

    current_mtime = os.path.getmtime(DB_FILE)
    if _DB_CACHE and current_mtime == _DB_MTIME:
        return _DB_CACHE

    try:
        with open(DB_FILE, "r", encoding="utf-8-sig") as f:
            raw_data = json.load(f)
    except Exception:
        return _DB_CACHE

    raw_items = raw_data if isinstance(raw_data, list) else raw_data.get("songs", [])
    valid_songs = []
    seen_keys = set()

    for idx, item in enumerate(raw_items):
        if not isinstance(item, dict):
            continue

        file_id = str(item.get("file_id") or "").strip()
        chat_id = item.get("from_chat_id") if item.get("from_chat_id") is not None else item.get("chat_id")
        message_id = item.get("message_id")

        if not file_id and not (chat_id and message_id):
            continue

        unique_key = file_id if file_id else f"{chat_id}_{message_id}"
        if unique_key in seen_keys:
            continue
        seen_keys.add(unique_key)

        raw_title = str(item.get("title") or "نامشخص").strip()
        raw_performer = str(item.get("performer") or "نامشخص").strip()
        title = clean_display_text(raw_title)
        performer = clean_display_text(raw_performer)

        search_text = item.get("search_text")
        search_text = normalize_text(search_text) if search_text else normalize_text(f"{raw_title} {raw_performer}")

        song_uid = f"{item.get('id', idx)}_{message_id or idx}"

        valid_songs.append({
            "uid": song_uid,
            "id": int(item.get("id", idx)),
            "chat_id": chat_id,
            "message_id": message_id,
            "file_id": file_id,
            "title": title,
            "performer": performer,
            "search_text": search_text,
            "can_stream": bool(file_id)
        })

    valid_songs.reverse()
    _DB_CACHE = valid_songs
    _DB_MTIME = current_mtime
    return _DB_CACHE


def verify_init_data(init_data: str) -> Optional[dict]:
    if not init_data or not BOT_TOKEN:
        return None
    try:
        parsed = dict(parse_qsl(init_data, strict_parsing=True))
        received_hash = parsed.pop("hash", None)
        if not received_hash:
            return None
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode("utf-8"), hashlib.sha256).digest()
        calc_hash = hmac.new(secret_key, data_check_string.encode("utf-8"), hashlib.sha256).hexdigest()
        if hmac.compare_digest(calc_hash, received_hash) and "user" in parsed:
            return json.loads(parsed["user"])
    except Exception:
        pass
    return None


@app.get("/", response_class=HTMLResponse)
async def index():
    template_path = os.path.join(os.path.dirname(__file__), "templates", "index.html")
    if not os.path.exists(template_path):
        template_path = "templates/index.html"
    with open(template_path, "r", encoding="utf-8") as f:
        return HTMLResponse(f.read())


@app.get("/api/songs")
async def api_get_songs(
    q: str = Query("", description="عبارت جستجو"),
    stream_only: bool = Query(False, description="فقط آهنگ‌های قابل پخش آنلاین"),
    offset: int = Query(0, ge=0),
    limit: int = Query(40, ge=1, le=100)
):
    songs = get_songs()
    if stream_only:
        songs = [s for s in songs if s["can_stream"]]

    norm_q = normalize_text(q)
    if norm_q:
        tokens = norm_q.split()
        exact_matches = [s for s in songs if all(t in s["search_text"] for t in tokens)]
        partial_matches = [
            s for s in songs
            if s not in exact_matches and any(t in s["search_text"] for t in tokens)
        ]
        filtered = exact_matches + partial_matches
    else:
        filtered = songs

    total = len(filtered)
    page_items = filtered[offset: offset + limit]

    return {
        "total": total,
        "items": [
            {
                "uid": s["uid"],
                "id": s["id"],
                "title": s["title"],
                "performer": s["performer"],
                "can_stream": s["can_stream"]
            }
            for s in page_items
        ]
    }


@app.get("/api/random")
async def api_random_song():
    import random
    songs = [s for s in get_songs() if s["can_stream"]]
    if not songs:
        raise HTTPException(status_code=404, detail="آهنگی یافت نشد")
    s = random.choice(songs)
    return {
        "uid": s["uid"],
        "id": s["id"],
        "title": s["title"],
        "performer": s["performer"],
        "can_stream": s["can_stream"]
    }


@app.get("/api/stream/{uid}")
async def api_stream_song(uid: str):
    songs = get_songs()
    song = next((s for s in songs if s["uid"] == uid), None)
    if not song or not song["file_id"]:
        raise HTTPException(status_code=404, detail="این ترک فاقد file_id برای پخش آنلاین است")

    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.get(f"{TELEGRAM_API}/getFile", params={"file_id": song["file_id"]})
        data = resp.json()
        if not data.get("ok"):
            raise HTTPException(status_code=502, detail="خطا در دریافت لینک فایل از تلگرام")
        file_path = data["result"]["file_path"]

    file_url = f"{TELEGRAM_FILE_API}/{file_path}"

    async def stream_chunks():
        async with httpx.AsyncClient(timeout=60.0) as stream_client:
            async with stream_client.stream("GET", file_url) as r:
                async for chunk in r.aiter_bytes(chunk_size=65536):
                    yield chunk

    media_type = "audio/mp4" if file_path.endswith(".m4a") else "audio/mpeg"
    return StreamingResponse(stream_chunks(), media_type=media_type)


@app.post("/api/send/{uid}")
async def api_send_song(uid: str, request: Request):
    body = await request.json()
    user_id = body.get("user_id")
    init_data = body.get("init_data", "")

    verified_user = verify_init_data(init_data)
    if verified_user:
        user_id = verified_user.get("id")

    if not user_id:
        raise HTTPException(status_code=400, detail="شناسه کاربر تلگرام یافت نشد")

    songs = get_songs()
    song = next((s for s in songs if s["uid"] == uid), None)
    if not song:
        raise HTTPException(status_code=404, detail="موزیک یافت نشد")

    async with httpx.AsyncClient(timeout=15.0) as client:
        if song["file_id"]:
            payload = {
                "chat_id": user_id,
                "audio": song["file_id"],
                "caption": f"🎵 {song['performer']} - {song['title']}\n🤖 @gapmusic1_bot"
            }
            r = await client.post(f"{TELEGRAM_API}/sendAudio", json=payload)
            if r.json().get("ok"):
                return JSONResponse({"status": "ok"})

        if song["chat_id"] and song["message_id"]:
            payload = {
                "chat_id": user_id,
                "from_chat_id": song["chat_id"],
                "message_id": int(song["message_id"])
            }
            r = await client.post(f"{TELEGRAM_API}/copyMessage", json=payload)
            if r.json().get("ok"):
                return JSONResponse({"status": "ok"})

    raise HTTPException(status_code=500, detail="ارسال موزیک به چت انجام نشد")


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("app:app", host="0.0.0.0", port=port)
