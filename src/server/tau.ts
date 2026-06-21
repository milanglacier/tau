#!/usr/bin/env node

const tau = require('./server-main.js');

if (require.main === module) {
  tau.startCli();
}

module.exports = tau;
