"""
violation_annotation.py
------------------------
Custom "Money Shot" HUD annotation for confirmed truck violations, drawn
directly onto a frame with cv2 - a deliberate replacement for the default
`results[0].plot()` box+label style.

The one hard invariant: the truck itself must stay 100% visible. No box or
fill is drawn over it - just a floating pointer triangle, positioned using
only y1 as its lower bound, so it can never land at or below the truck's own
top edge.
"""

import os

import cv2
import numpy as np

# Pointer icon: a pre-made red rounded triangle, alpha-composited above the
# box instead of hand-drawn, so it matches the exact reference asset.
_ICON_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "public", "Red-Triangle-Flat-icon.png"
)
_pointer_icon_cache = None  # lazily loaded: cropped-to-content, apex-down BGRA, or False if unusable


def draw_violation_annotation(frame, x1, y1, x2, y2, box_color=(0, 0, 255), scale=1.0):
    """Draws a floating pointer above one detected truck, marking it as a
    violation without drawing anything over the truck itself.

    Args:
        frame: BGR image (np.ndarray), drawn on in place.
        x1, y1, x2, y2: box corners in pixel coordinates.
        box_color: fallback pointer color, used only if the icon asset can't
            be loaded (see `_draw_fallback_triangle`).
        scale: multiplies the marker's pixel sizes, for frames that were
            upscaled from the 640-px-wide inference frame.

    Returns:
        The same frame object, for chaining.
    """
    x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)

    # Floating pointer: the red triangle icon, apex down, anchored to the
    # truck's top-center, sitting entirely above y1.
    box_center_x = (x1 + x2) // 2

    TRIANGLE_WIDTH = max(1, round(12 * scale))  # target on-screen width of the pointer icon, in px
    TRIANGLE_GAP = max(1, round(4 * scale))    # gap between the icon's apex tip and the box's top edge
    TRIANGLE_OPACITY = 1.0  # triangle itself: 0.0 (invisible) to 1.0 (fully solid)
    BG_GLOW_OPACITY = 1   # soft red glow behind the triangle: 0.0 (none) to 1.0 (strong)

    apex_y = min(y1 - TRIANGLE_GAP, y1 - max(1, round(2 * scale)))  # apex must stay strictly above the box

    if not _draw_pointer_icon(frame, apex=(box_center_x, apex_y), target_width=TRIANGLE_WIDTH,
                          opacity=TRIANGLE_OPACITY, glow_opacity=BG_GLOW_OPACITY):
        # Fallback if the icon asset is missing/unreadable, so a violation
        # frame is never silently drawn without any pointer at all.
        _draw_fallback_triangle(frame, apex=(box_center_x, apex_y), color=box_color)

    return frame


def _load_pointer_icon():
    """Loads and caches the pointer icon: trimmed to its opaque content and
    flipped so the triangle's apex points down. Returns False if the asset
    can't be used, so callers can fall back without crashing."""
    global _pointer_icon_cache
    if _pointer_icon_cache is not None:
        return _pointer_icon_cache

    icon = cv2.imread(_ICON_PATH, cv2.IMREAD_UNCHANGED)
    if icon is None or icon.ndim != 3 or icon.shape[2] != 4:
        _pointer_icon_cache = False
        return _pointer_icon_cache

    ys, xs = np.where(icon[:, :, 3] > 0)  # bounding box of the opaque triangle
    if len(ys) == 0:
        _pointer_icon_cache = False
        return _pointer_icon_cache

    icon = icon[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    icon = cv2.flip(icon, 0)  # the source icon points up; we need apex-down
    _pointer_icon_cache = icon
    return icon


def _draw_pointer_icon(frame, apex, target_width, opacity=1.0, glow_opacity=1.0):
    """Alpha-composites the pointer icon onto `frame` with its apex at `apex`.

    Returns True if drawn, False if the icon asset is unusable.
    """
    icon = _load_pointer_icon()
    if icon is False:
        return False

    src_h, src_w = icon.shape[:2]
    target_height = max(1, round(target_width * src_h / src_w))
    resized = cv2.resize(icon, (target_width, target_height), interpolation=cv2.INTER_AREA)
    resized[:, :, 3] = (resized[:, :, 3].astype(np.float32) * opacity).clip(0, 255).astype(np.uint8)

    apex_x, apex_y = apex
    left = apex_x - target_width // 2
    top = apex_y - target_height  # icon's bottom row (the apex) lands on apex_y

    # The halo was tuned for a 12px icon: scale its blur and padding with the icon
    # so it keeps the same proportions at any resolution (e.g. the 1080p snapshot).
    k = target_width / 12.0
    blur = max(3, int(round(21 * k)) | 1)  # GaussianBlur needs an odd kernel
    _blit_glow(frame, resized, left, top, blur_ksize=blur, glow_alpha_scale=glow_opacity,
               pad=max(1, int(round(14 * k))))
    _alpha_blit(frame, resized, left, top)
    return True


def _blit_glow(frame, icon_bgra, left, top, glow_color=(60, 60, 255),
                blur_ksize=21, glow_alpha_scale=1.0, pad=14):
    """Draws a soft red halo behind the icon so the marker reads as brighter
    and pops against dark/low-contrast footage, without altering the flat
    icon's own colors."""
    h, w = icon_bgra.shape[:2]
    alpha = icon_bgra[:, :, 3]

    padded = np.zeros((h + 2 * pad, w + 2 * pad), dtype=np.uint8)
    padded[pad:pad + h, pad:pad + w] = alpha

    blurred = cv2.GaussianBlur(padded, (blur_ksize, blur_ksize), 0)
    blurred = (blurred.astype(np.float32) * glow_alpha_scale).clip(0, 255).astype(np.uint8)

    glow_bgra = np.zeros((*blurred.shape, 4), dtype=np.uint8)
    glow_bgra[:, :, 0] = glow_color[0]
    glow_bgra[:, :, 1] = glow_color[1]
    glow_bgra[:, :, 2] = glow_color[2]
    glow_bgra[:, :, 3] = blurred

    _alpha_blit(frame, glow_bgra, left - pad, top - pad)


def _alpha_blit(frame, overlay_bgra, left, top):
    """Blends a BGRA `overlay_bgra` onto `frame` at (left, top), cropping to
    whatever portion of the overlay actually falls inside the frame."""
    frame_h, frame_w = frame.shape[:2]
    overlay_h, overlay_w = overlay_bgra.shape[:2]

    src_x1, src_y1 = 0, 0
    dst_x1, dst_y1 = left, top
    if dst_x1 < 0:
        src_x1, dst_x1 = -dst_x1, 0
    if dst_y1 < 0:
        src_y1, dst_y1 = -dst_y1, 0
    dst_x2 = min(frame_w, left + overlay_w)
    dst_y2 = min(frame_h, top + overlay_h)
    src_x2 = src_x1 + max(0, dst_x2 - dst_x1)
    src_y2 = src_y1 + max(0, dst_y2 - dst_y1)

    if dst_x2 <= dst_x1 or dst_y2 <= dst_y1:
        return  # icon falls entirely outside the frame

    region = frame[dst_y1:dst_y2, dst_x1:dst_x2].astype(np.float32)
    patch = overlay_bgra[src_y1:src_y2, src_x1:src_x2]
    alpha = patch[:, :, 3:4].astype(np.float32) / 255.0
    blended = patch[:, :, :3].astype(np.float32) * alpha + region * (1.0 - alpha)

    frame[dst_y1:dst_y2, dst_x1:dst_x2] = blended.astype(np.uint8)


def _draw_fallback_triangle(frame, apex, color, height=22, half_base=16, corner_radius=4):
    """Hand-drawn stand-in for the pointer icon (used only if the PNG asset
    can't be loaded), with rounded corners faked via a circle at each vertex."""
    apex_x, apex_y = apex
    base_y = max(2, apex_y - height)
    pts = np.array(
        [
            [apex_x, apex_y],
            [apex_x - half_base, base_y],
            [apex_x + half_base, base_y],
        ],
        dtype=np.int32,
    )

    pad = 14
    mask = np.zeros((height + 2 * pad, 2 * half_base + 2 * pad + corner_radius * 2), dtype=np.uint8)
    offset = np.array([half_base + pad + corner_radius, pad])
    mask_pts = np.array(
        [
            [offset[0], offset[1] + height],
            [offset[0] - half_base, offset[1]],
            [offset[0] + half_base, offset[1]],
        ],
        dtype=np.int32,
    )
    cv2.fillConvexPoly(mask, mask_pts, 255, lineType=cv2.LINE_AA)
    for (vx, vy) in mask_pts:
        cv2.circle(mask, (int(vx), int(vy)), corner_radius, 255, -1, lineType=cv2.LINE_AA)
    glow_alpha = cv2.GaussianBlur(mask, (21, 21), 0)

    glow_bgra = np.zeros((*glow_alpha.shape, 4), dtype=np.uint8)
    glow_bgra[:, :, 0], glow_bgra[:, :, 1], glow_bgra[:, :, 2] = color
    glow_bgra[:, :, 3] = glow_alpha
    _alpha_blit(frame, glow_bgra, apex_x - offset[0], base_y - pad)

    cv2.fillConvexPoly(frame, pts, color, lineType=cv2.LINE_AA)
    for (vx, vy) in pts:
        cv2.circle(frame, (int(vx), int(vy)), corner_radius, color, -1, lineType=cv2.LINE_AA)
