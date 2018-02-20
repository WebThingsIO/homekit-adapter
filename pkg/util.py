"""Utility functions."""

import colorsys


def hsv_to_rgb(h, s, v):
    """
    Convert an HSV tuple to an RGB hex string.

    h -- hue (0-360)
    s -- saturation (0-100)
    v -- value (0-100)

    Returns a hex RGB string, i.e. #123456.
    """
    r, g, b = tuple(int(i * 255)
                    for i in colorsys.hsv_to_rgb(h / 360, s / 100, v / 100))
    return '#{:02X}{:02X}{:02X}'.format(r, g, b)


def rgb_to_hsv(rgb):
    """
    Convert an RGB hex string to an HSV tuple.

    rgb -- RGB hex string, i.e. #123456

    Returns an RGB tuple, i.e. (360, 100, 100).
    """
    rgb = rgb.lstrip('#')
    r, g, b = tuple(int(rgb[i:i + 2], 16) / 255 for i in range(0, 6, 2))
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    return (int(h * 360), int(s * 100), int(v * 100))
