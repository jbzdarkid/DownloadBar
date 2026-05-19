"""
Extract focused frame strips from a screen recording, aligned to the
run.log emitted by run_shelf_tests.py.

Typical usage during analysis:

    # show what marks are available in the log
    python tests\\extract.py list

    # pull ~5 s of frames around the A1 download trigger, cropped to the
    # shelf strip, at 10 fps
    python tests\\extract.py clip "<path-to>\\foo.mp4" \\
        --label A1 --window 5 --crop shelf

    # one full frame at a specific wall-clock time, to calibrate the
    # shelf rectangle visually
    python tests\\extract.py frame "<path-to>\\clip.mp4" --at 00:00:13

Video time is computed as (event_wall - video_start_wall). The video
start wall time is either:
  * parsed from a filename like "2026-05-15 15-11-01.mp4" (OBS default), or
  * passed explicitly via --video-start "YYYY-MM-DD HH:MM:SS".

Crop presets ("shelf", "full") read from tests/calibration.json so they
survive across runs. The first time you use --crop shelf, run the
"calibrate" subcommand to record the rectangle.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
LOG_FILE = REPO_ROOT / "tests" / "run.log"
CALIB_FILE = REPO_ROOT / "tests" / "calibration.json"
DEFAULT_OUT = REPO_ROOT / "tests" / "frames"

FILENAME_RE = re.compile(r"(\d{4}-\d{2}-\d{2})[ _T](\d{2})[-:](\d{2})[-:](\d{2})")


# ---- log parsing ----------------------------------------------------------

def parse_log(path: Path) -> list[dict]:
    if not path.exists():
        sys.exit(f"log not found at {path}; run tests/run_shelf_tests.py first")
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line or line.startswith("#"):
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        iso, t_offset, kind, label, msg = parts[0], parts[1], parts[2], parts[3], "\t".join(parts[4:])
        try:
            rows.append({
                "iso": iso,
                "wall": datetime.fromisoformat(iso),
                "t_offset": float(t_offset),
                "kind": kind,
                "label": label,
                "msg": msg,
            })
        except ValueError:
            continue
    return rows


def find_mark(rows: list[dict], label: str, event: str | None = None) -> dict:
    """Find the first 'mark' row for the given label (optionally also matching msg)."""
    for r in rows:
        if r["kind"] != "mark":
            continue
        if r["label"] != label:
            continue
        if event and event not in r["msg"]:
            continue
        return r
    sys.exit(f"no mark found for label={label!r} event={event!r}")


def find_recording_anchor(rows: list[dict]) -> datetime:
    """The 'RECORDING' mark is emitted right after the user confirms recording is rolling."""
    for r in rows:
        if r["kind"] == "mark" and r["label"] == "RECORDING":
            return r["wall"]
    sys.exit("no RECORDING anchor in log; runner did not emit recording start")


# ---- video start ----------------------------------------------------------

def video_start_from_filename(path: Path) -> datetime | None:
    m = FILENAME_RE.search(path.name)
    if not m:
        return None
    date_part, hh, mm, ss = m.groups()
    return datetime.fromisoformat(f"{date_part}T{hh}:{mm}:{ss}")


def resolve_video_start(video: Path, explicit: str | None) -> datetime:
    if explicit:
        return datetime.fromisoformat(explicit.replace(" ", "T"))
    parsed = video_start_from_filename(video)
    if parsed is not None:
        return parsed
    sys.exit(
        "cannot determine video start time. Either rename your file to "
        "'YYYY-MM-DD HH-MM-SS.mp4' (OBS default) or pass "
        "--video-start \"YYYY-MM-DD HH:MM:SS\"."
    )


# ---- calibration ----------------------------------------------------------

def load_calibration() -> dict:
    if CALIB_FILE.exists():
        return json.loads(CALIB_FILE.read_text(encoding="utf-8"))
    return {}


def save_calibration(d: dict) -> None:
    CALIB_FILE.write_text(json.dumps(d, indent=2), encoding="utf-8")


def resolve_crop(spec: str | None) -> str | None:
    """Returns an ffmpeg crop filter argument like 'w:h:x:y', or None."""
    if spec is None or spec == "full":
        return None
    calib = load_calibration()
    if spec in calib:
        c = calib[spec]
        return f"{c['w']}:{c['h']}:{c['x']}:{c['y']}"
    # raw "w:h:x:y" form, or "WxH+X+Y"
    m = re.match(r"^\s*(\d+):(\d+):(\d+):(\d+)\s*$", spec)
    if m:
        return f"{m.group(1)}:{m.group(2)}:{m.group(3)}:{m.group(4)}"
    m = re.match(r"^\s*(\d+)x(\d+)\+(\d+)\+(\d+)\s*$", spec)
    if m:
        return f"{m.group(1)}:{m.group(2)}:{m.group(3)}:{m.group(4)}"
    sys.exit(
        f"unknown crop {spec!r}. Use a preset (shelf/full), 'w:h:x:y', or "
        f"'WxH+X+Y'. Presets currently defined: {list(calib)}"
    )


# ---- ffmpeg ---------------------------------------------------------------

def _ffmpeg_exe() -> str:
    """Resolve an ffmpeg binary, preferring imageio-ffmpeg's bundled one.

    Matches extract_frames.py so neither tool needs a system ffmpeg install.
    """
    try:
        import imageio_ffmpeg  # type: ignore
    except ImportError:
        pass
    else:
        return imageio_ffmpeg.get_ffmpeg_exe()
    import shutil as _sh
    on_path = _sh.which("ffmpeg")
    if on_path:
        return on_path
    sys.exit(
        "ffmpeg not found. Install imageio-ffmpeg in your venv "
        "(pip install imageio-ffmpeg) or install ffmpeg system-wide."
    )


def run_ffmpeg(args: list[str]) -> None:
    proc = subprocess.run(
        [_ffmpeg_exe(), "-y", "-hide_banner", "-loglevel", "error", *args],
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr)
        sys.exit(f"ffmpeg failed (exit {proc.returncode})")


def extract_clip(video: Path, start: float, duration: float, crop: str | None,
                 fps: float, out_dir: Path, prefix: str) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    # purge any prior frames with the same prefix to avoid confusion
    for old in out_dir.glob(f"{prefix}_*.jpg"):
        old.unlink()
    vf = [f"fps={fps}"]
    if crop:
        vf.append(f"crop={crop}")
    args = [
        "-ss", f"{max(start, 0):.3f}",
        "-i", str(video),
        "-t", f"{duration:.3f}",
        "-vf", ",".join(vf),
        "-q:v", "3",
        str(out_dir / f"{prefix}_%03d.jpg"),
    ]
    run_ffmpeg(args)
    return sorted(out_dir.glob(f"{prefix}_*.jpg"))


def extract_frame(video: Path, at_seconds: float, crop: str | None,
                  out: Path) -> Path:
    vf = [f"crop={crop}"] if crop else []
    args = [
        "-ss", f"{max(at_seconds, 0):.3f}",
        "-i", str(video),
        "-frames:v", "1",
    ]
    if vf:
        args += ["-vf", ",".join(vf)]
    args += ["-q:v", "2", str(out)]
    run_ffmpeg(args)
    return out


# ---- commands -------------------------------------------------------------

def cmd_list(args: argparse.Namespace) -> int:
    rows = parse_log(Path(args.log))
    anchor = find_recording_anchor(rows)
    print(f"recording anchor: {anchor.isoformat()}")
    print()
    print(f"{'video_t':>8s}  {'label':<8s}  {'kind':<14s}  msg")
    for r in rows:
        if r["kind"] not in ("mark", "log"):
            continue
        if r["kind"] == "log" and not r["label"]:
            continue
        offset = (r["wall"] - anchor).total_seconds()
        print(f"{offset:8.2f}  {r['label']:<8s}  {r['kind']:<14s}  {r['msg']}")
    return 0


def cmd_clip(args: argparse.Namespace) -> int:
    video = Path(args.video).resolve()
    if not video.exists():
        sys.exit(f"video not found: {video}")
    rows = parse_log(Path(args.log))
    anchor_wall = find_recording_anchor(rows)
    target = find_mark(rows, args.label, args.event)

    # Two ways to align log time to video time:
    #  1. --anchor-at SECONDS: caller supplies the video timestamp of the
    #     RECORDING mark (e.g. measured visually from a probe frame). Then
    #     event_video_time = anchor_at + (event_wall - anchor_wall).
    #  2. filename / --video-start: video time is (event_wall - video_start).
    #     OBS filenames lag actual frame 0 by ~0.5-1s so this is approximate.
    if args.anchor_at is not None:
        anchor_video_time = float(args.anchor_at)
        video_start = anchor_wall - timedelta(seconds=anchor_video_time)
        event_video_time = anchor_video_time + (target["wall"] - anchor_wall).total_seconds()
    else:
        video_start = resolve_video_start(video, args.video_start)
        anchor_video_time = (anchor_wall - video_start).total_seconds()
        event_video_time = (target["wall"] - video_start).total_seconds()

    window = float(args.window)
    pre = float(args.pre) if args.pre is not None else window / 2
    post = float(args.post) if args.post is not None else window / 2
    start = event_video_time - pre
    duration = pre + post

    crop = resolve_crop(args.crop)
    out_dir = Path(args.out)
    prefix = f"{args.label}_{(args.event or 'mark').replace(' ', '_')}"

    print(f"video start (wall):     {video_start.isoformat()}")
    print(f"recording anchor:       {anchor_wall.isoformat()}  (video t={anchor_video_time:.2f}s)")
    print(f"event:                  {target['msg']!r} at {target['iso']}")
    print(f"event video time:       {event_video_time:.2f}s")
    print(f"slice:                  start={start:.2f}s  duration={duration:.2f}s  fps={args.fps}")
    print(f"crop:                   {crop or '(none)'}")
    print(f"writing frames into:    {out_dir}")

    frames = extract_clip(video, start, duration, crop, args.fps, out_dir, prefix)
    print(f"wrote {len(frames)} frame(s)")
    return 0


def cmd_frame(args: argparse.Namespace) -> int:
    video = Path(args.video).resolve()
    if not video.exists():
        sys.exit(f"video not found: {video}")
    # --at accepts either seconds or HH:MM:SS
    s = args.at
    if ":" in s:
        h, m, sec = s.split(":")
        at = int(h) * 3600 + int(m) * 60 + float(sec)
    else:
        at = float(s)
    crop = resolve_crop(args.crop)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    extract_frame(video, at, crop, out)
    print(f"wrote {out}")
    return 0


def cmd_calibrate(args: argparse.Namespace) -> int:
    calib = load_calibration()
    spec = args.rect
    m = re.match(r"^(\d+):(\d+):(\d+):(\d+)$", spec) or re.match(r"^(\d+)x(\d+)\+(\d+)\+(\d+)$", spec)
    if not m:
        sys.exit("rect must be 'w:h:x:y' or 'WxH+X+Y'")
    if "x" in spec and "+" in spec:
        w, h, x, y = map(int, m.groups())
    else:
        w, h, x, y = int(m.group(1)), int(m.group(2)), int(m.group(3)), int(m.group(4))
    calib[args.name] = {"w": w, "h": h, "x": x, "y": y}
    save_calibration(calib)
    print(f"saved calibration {args.name!r} = {calib[args.name]}")
    print(f"file: {CALIB_FILE}")
    return 0


# ---- arg parsing ----------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="extract", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    common_log = {"default": str(LOG_FILE), "help": f"path to run.log (default {LOG_FILE})"}

    pl = sub.add_parser("list", help="list marks/events in the runner log")
    pl.add_argument("--log", **common_log)
    pl.set_defaults(fn=cmd_list)

    pc = sub.add_parser("clip", help="extract a frame strip around a marked event")
    pc.add_argument("video", help="path to the screen recording")
    pc.add_argument("--label", required=True, help="scenario label, e.g. A1")
    pc.add_argument("--event", help="optional substring match against the mark message")
    pc.add_argument("--window", type=float, default=5.0, help="total seconds around the event")
    pc.add_argument("--pre", type=float, help="seconds before the event (default window/2)")
    pc.add_argument("--post", type=float, help="seconds after the event (default window/2)")
    pc.add_argument("--fps", type=float, default=10.0, help="frames per second to emit")
    pc.add_argument("--crop", help="crop preset name or 'w:h:x:y' / 'WxH+X+Y'")
    pc.add_argument("--out", default=str(DEFAULT_OUT), help="output directory")
    pc.add_argument("--video-start", help="override video start wall time")
    pc.add_argument("--anchor-at", type=float,
                    help="seconds into the video where the RECORDING mark "
                         "fires; if set, overrides --video-start and removes "
                         "OBS-filename clock skew")
    pc.add_argument("--log", **common_log)
    pc.set_defaults(fn=cmd_clip)

    pf = sub.add_parser("frame", help="extract a single frame at a given offset")
    pf.add_argument("video")
    pf.add_argument("--at", required=True, help="seconds or HH:MM:SS into the video")
    pf.add_argument("--crop", help="crop preset name or rect")
    pf.add_argument("--out", default=str(DEFAULT_OUT / "single.jpg"))
    pf.set_defaults(fn=cmd_frame)

    pcal = sub.add_parser("calibrate", help="store a named crop rectangle")
    pcal.add_argument("name", help="preset name, e.g. 'shelf'")
    pcal.add_argument("rect", help="'w:h:x:y' or 'WxH+X+Y'")
    pcal.set_defaults(fn=cmd_calibrate)

    return p


def main(argv: list[str]) -> int:
    args = build_parser().parse_args(argv)
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
