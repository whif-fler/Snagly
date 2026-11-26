'use strict';

// The legacy local server keeps importing lib/util. It now delegates to the
// shared core package so validation cannot drift between local and cloud modes.
module.exports = require('../packages/core');
