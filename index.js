'use strict';

const HomeKitAdapter = require('./lib/homekit-adapter');

module.exports = (addonManager, manifest) => {
  new HomeKitAdapter(addonManager, manifest);
};
