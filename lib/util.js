/**
 * Utility functions.
 */
'use strict';

const Color = require('color');

/**
 * Convert an HSV tuple to an RGB hex string.
 *
 * @param {number} h - Hue (0-360)
 * @param {number} s - Saturation (0-100)
 * @param {number} v - Value (0-100)
 * @returns {string} Hex RGB string, i.e. #123456.
 */
function hsvToRgb(h, s, v) {
  return Color({h, s, v}).hex();
}

/**
 * Convert an RGB hex string to an HSV tuple.
 *
 * @param {string} rgb - RGB hex string, i.e. #123456
 * @returns {Object} HSV object, i.e. {h, s, v}
 */
function rgbToHsv(rgb) {
  return Color(rgb).hsv().object();
}

module.exports = {
  hsvToRgb,
  rgbToHsv,
};
