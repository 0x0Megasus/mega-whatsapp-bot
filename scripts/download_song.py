#!/usr/bin/env python3
"""
Simple YouTube audio downloader for bot integration.
Requires: yt-dlp (apt package or pip install yt-dlp)
"""

import argparse
import json
import os
import tempfile
from pathlib import Path

import yt_dlp
from yt_dlp.utils import DownloadError


def parse_args():
    parser = argparse.ArgumentParser(description="Download a song query or YouTube URL as MP3")
    parser.add_argument("--input", required=True, help="Song name query or YouTube URL")
    parser.add_argument("--output", required=True, help="Absolute output .mp3 file path")
    return parser.parse_args()


def resolve_cookie_file():
    cookies_path = os.getenv("YTDLP_COOKIES_PATH", "").strip()
    if cookies_path and Path(cookies_path).exists():
        return cookies_path, None

    cookies_b64 = os.getenv("YTDLP_COOKIES_B64", "").strip()
    if not cookies_b64:
        return None, None

    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".txt")
    tmp.write(__import__("base64").b64decode(cookies_b64))
    tmp.flush()
    tmp.close()
    return tmp.name, tmp.name


def find_downloaded_file(base_without_ext: Path):
    candidates = list(base_without_ext.parent.glob(f"{base_without_ext.name}.*"))
    candidates = [p for p in candidates if p.suffix != ".part"]
    if not candidates:
        return None
    mp3 = [p for p in candidates if p.suffix.lower() == ".mp3"]
    return mp3[0] if mp3 else candidates[0]


def main():
    args = parse_args()
    output_path = Path(args.output).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    base = output_path.with_suffix("")
    outtmpl = str(base) + ".%(ext)s"

    ffmpeg_path = os.getenv("FFMPEG_BINARY_PATH", "")
    base_ydl_opts = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "outtmpl": outtmpl,
        "postprocessors": [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ],
    }
    if ffmpeg_path:
        base_ydl_opts["ffmpeg_location"] = ffmpeg_path
    cookie_file, temp_cookie_file = resolve_cookie_file()
    if cookie_file:
        base_ydl_opts["cookiefile"] = cookie_file

    target = args.input.strip()
    is_direct_url = target.startswith("http://") or target.startswith("https://")
    if not is_direct_url:
        target = f"ytsearch5:{target}"

    client_variants = [None, ["web"], ["android"], ["ios"]]

    def extract_with_client_fallback(url, download):
        last_error = None
        for clients in client_variants:
            opts = dict(base_ydl_opts)
            if clients:
                opts["extractor_args"] = {"youtube": {"player_client": clients}}
            ydl = yt_dlp.YoutubeDL(opts)
            try:
                return ydl.extract_info(url, download=download)
            except DownloadError as err:
                last_error = err
        if last_error is not None:
            raise last_error
        raise RuntimeError("yt_dlp extraction failed with no error detail.")

    info = None
    try:
        if is_direct_url:
            info = extract_with_client_fallback(target, True)
        else:
            search_result = extract_with_client_fallback(target, False)
            entries = [e for e in (search_result or {}).get("entries", []) if e]
            last_error = None
            for entry in entries:
                entry_url = entry.get("webpage_url") or entry.get("url")
                if not entry_url:
                    continue
                try:
                    info = extract_with_client_fallback(entry_url, True)
                    if info:
                        break
                except DownloadError as err:
                    last_error = err
            if info is None and last_error is not None:
                raise last_error
            if info is None:
                raise RuntimeError("No downloadable search results found.")
    finally:
        if temp_cookie_file:
            try:
                Path(temp_cookie_file).unlink(missing_ok=True)
            except Exception:
                pass

    downloaded = find_downloaded_file(base)
    if downloaded is None:
        raise RuntimeError("yt_dlp finished but no output file was created.")

    if downloaded.resolve() != output_path:
        if output_path.exists():
            output_path.unlink()
        downloaded.replace(output_path)

    payload = {
        "output": str(output_path),
        "title": (info or {}).get("title", ""),
        "uploader": (info or {}).get("uploader", ""),
        "webpage_url": (info or {}).get("webpage_url", ""),
        "duration": int((info or {}).get("duration") or 0),
    }
    print(json.dumps(payload, ensure_ascii=True))


if __name__ == "__main__":
    main()
