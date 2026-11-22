"""Encode frames as H.264 MP4 or VP9 WebM (with alpha) using FFmpeg."""

from collections.abc import Iterable
from itertools import chain
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import NamedTemporaryFile, TemporaryFile

from PIL import Image


H264_ARGS = (
    "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
    "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-fps_mode", "passthrough", "-movflags", "+faststart",
)


def vp9_args(crf: int) -> tuple[str, ...]:
    """VP9 settings that keep an alpha channel; alt-ref frames must be off for alpha."""
    return (
        "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", str(crf),
        "-deadline", "good", "-cpu-used", "2", "-row-mt", "1", "-auto-alt-ref", "0",
        "-an", "-f", "webm",
    )


def _ffmpeg_executable() -> str:
    # A host that already resolved a trusted FFmpeg (such as DODO MCP) passes it explicitly.
    configured = os.environ.get("GIFT_FFMPEG")
    if configured:
        if not os.path.isabs(configured) or not os.path.isfile(configured):
            raise RuntimeError("GIFT_FFMPEG must be the absolute path of an FFmpeg executable.")
        return configured
    executable = shutil.which("ffmpeg")
    if executable:
        return executable
    try:
        from imageio_ffmpeg import get_ffmpeg_exe

        return get_ffmpeg_exe()
    except (ImportError, RuntimeError) as exc:
        raise RuntimeError("Video export needs FFmpeg on PATH (or imageio-ffmpeg).") from exc


def encode_video(frames: Iterable[Image.Image], path: Path, fps: int, *, mode: str = "RGB",
                 codec_args: Iterable[str] = H264_ARGS, overwrite: bool = False) -> None:
    """Pipe same-sized `mode` frames (RGB or RGBA) into FFmpeg at a fixed frame rate.

    The file is written beside `path` and only published after FFmpeg succeeds.
    """
    if type(fps) is not int or fps <= 0:
        raise ValueError("Video frame rate must be a positive integer.")
    if mode not in ("RGB", "RGBA"):
        raise ValueError("Video frames must be RGB or RGBA.")
    if not overwrite and (path.exists() or path.is_symlink()):
        raise FileExistsError(f"Output already exists: {path}")

    remaining = iter(frames)
    first = next(remaining, None)
    if not isinstance(first, Image.Image) or first.mode != mode or min(first.size) <= 0:
        raise ValueError(f"Video export requires at least one nonempty {mode} frame.")
    width, height = first.size
    executable = _ffmpeg_executable()

    path.parent.mkdir(parents=True, exist_ok=True)
    with NamedTemporaryFile(dir=path.parent, suffix=path.suffix, delete=False) as pending:
        temporary = Path(pending.name)
    try:
        command = [
            executable, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
            "-f", "rawvideo", "-pixel_format", "rgb24" if mode == "RGB" else "rgba",
            "-video_size", f"{width}x{height}", "-framerate", str(fps), "-i", "pipe:0",
            *codec_args, str(temporary),
        ]
        with TemporaryFile() as errors, subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=errors,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        ) as encoder:
            assert encoder.stdin is not None
            pipe_error = None
            try:
                with encoder.stdin as pipe:
                    for frame in chain((first,), remaining):
                        if not isinstance(frame, Image.Image) or frame.mode != mode or frame.size != first.size:
                            raise ValueError(f"Every video frame must be {mode} and match the first frame's size.")
                        pipe.write(frame.tobytes())
            except BrokenPipeError as exc:
                pipe_error = exc
            except BaseException:
                encoder.kill()
                raise
            status = encoder.wait()
            if status != 0 or pipe_error is not None:
                errors.seek(0)
                details = errors.read(4096).decode("utf-8", errors="replace").strip()
                if not details:
                    details = f"exit status {status}" if status else "closed the frame stream early"
                raise RuntimeError(f"FFmpeg could not encode the video: {details}") from pipe_error

        # Without overwrite, publication fails if someone created the target while encoding.
        if overwrite:
            temporary.replace(path)
        elif os.name == "nt":
            temporary.rename(path)
        else:
            path.hardlink_to(temporary)
    finally:
        temporary.unlink(missing_ok=True)


def save_scene_mp4(frames: Iterable[Image.Image], path: Path, fps: int) -> None:
    """Save each supplied RGB frame once at a fixed rate without replacing an existing file.

    A frame with an odd width or height is padded on the right or bottom for yuv420p.
    """
    if path.suffix.lower() != ".mp4":
        raise ValueError("MP4 output must use an .mp4 filename.")
    encode_video(frames, path, fps, mode="RGB", codec_args=H264_ARGS)
