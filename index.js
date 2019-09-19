'use strict';

const HomeKitAdapter = require('./lib/homekit-adapter');

module.exports = (addonManager) => {
  new HomeKitAdapter(addonManager);
};
