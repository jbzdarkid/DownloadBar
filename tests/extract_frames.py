"""
Extract frames from a screen recording so they can be reviewed as images.

Uses ffmpeg via the imageio-ffmpeg wheel (no system ffmpeg required).

Usage:
  python tests/extract_frames.py <video> [--fps 4] [--out frames/]
        [--start SEC] [--end SEC] [--crop X,Y,W,H]

Examples:
  # Default: 4 fps, full frame, into ./frames/<videoname>/
  python tests/extract_frames.py "<path-to>/clip.mp4"

  # Crop to the top-left 1280x800 (where the Chromium window lives)
  python tests/extract_frames.py clip.mp4 --crop 0,0,1280,800 --fps 6
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path


def find_ffmpeg() -> str:
    """Resolve an ffmpeg binary, preferring imageio-ffmpeg's bundled one."""
    try:
        import imageio_ffmpeg  # type: ignore
    except ImportError:
        pass
    else:
        return imageio_ffmpeg.get_ffmpeg_exe()
    on_path = shutil.which("ffmpeg")
    if on_path:
        return on_path
    sys.exit(
        "ffmpeg not found. Install imageio-ffmpeg in your venv "
        "(pip install imageio-ffmpeg) or install ffmpeg system-wide."
    )


def build_filter(fps: float, crop: str | None) -> str:
    parts = [f"fps={fps}"]
    if crop:
        try:
            x, y, w, h = [int(v) for v in crop.split(",")]
        except ValueError:
            sys.exit("--crop must be 'X,Y,W,H' with integers")
        parts.append(f"crop={w}:{h}:{x}:{y}")
    return ",".join(parts)


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    p.add_argument("video")
    p.add_argument("--fps", type=float, default=4.0)
    p.add_argument("--out", default=None,
                   help="output directory (default: frames/<video-stem>/)")
    p.add_argument("--start", type=float, default=None, help="seconds")
    p.add_argument("--end", type=float, default=None, help="seconds")
    p.add_argument("--crop", default=None, help="X,Y,W,H pixel crop")
    args = p.parse_args(argv)

    video = Path(args.video).resolve()
    if not video.exists():
        sys.exit(f"not found: {video}")

    out = Path(args.out) if args.out else Path("frames") / video.stem
    out.mkdir(parents=True, exist_ok=True)
    # Wipe prior contents so reruns are clean.
    for old in out.glob("*.png"):
        old.unlink()

    ffmpeg = find_ffmpeg()
    vf = build_filter(args.fps, args.crop)

    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error"]
    if args.start is not None:
        cmd += ["-ss", str(args.start)]
    cmd += ["-i", str(video)]
    if args.end is not None and args.start is not None:
        cmd += ["-t", str(args.end - args.start)]
    elif args.end is not None:
        cmd += ["-t", str(args.end)]
    cmd += ["-vf", vf, str(out / "frame_%04d.png")]

    print("running:", " ".join(f'"{c}"' if " " in c else c for c in cmd))
    subprocess.run(cmd, check=True)

    frames = sorted(out.glob("*.png"))
    print(f"wrote {len(frames)} frames to {out}")
    if frames:
        print(f"  first: {frames[0]}")
        print(f"  last : {frames[-1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
