#!/usr/bin/env python3
"""
Simple YouTube audio downloader for bot integration.
Requires: pip install yt-dlp
"""

import argparse
import os
from pathlib import Path

import yt_dlp


def parse_args():
    parser = argparse.ArgumentParser(description="Download a YouTube URL as MP3")
    parser.add_argument("--url", required=True, help="YouTube video URL")
    parser.add_argument("--output", required=True, help="Absolute output .mp3 file path")
    return parser.parse_args()


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
    ydl_opts = {
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
        ydl_opts["ffmpeg_location"] = ffmpeg_path

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        ydl.download([args.url])

    downloaded = find_downloaded_file(base)
    if downloaded is None:
        raise RuntimeError("yt_dlp finished but no output file was created.")

    if downloaded.resolve() != output_path:
        if output_path.exists():
            output_path.unlink()
        downloaded.replace(output_path)

    print(str(output_path))


if __name__ == "__main__":
    main()
