'use strict';

/**
 * Stable, versioned HTTP contract. Types live in contracts.ts; this module is
 * the runtime side the server and tests share.
 */
const API_VERSION = '1';

const CAPABILITIES = Object.freeze({
  cloud: Object.freeze({
    mode: 'cloud',
    localFolderPicker: false,
    serverTagEditing: true,
    fileSystemAccess: true,
    standardDownloads: true,
    zipDownload: true,
    arbitraryServerPaths: false
  }),
  local: Object.freeze({
    mode: 'local',
    localFolderPicker: true,
    serverTagEditing: true,
    fileSystemAccess: false,
    standardDownloads: false,
    zipDownload: false,
    arbitraryServerPaths: true
  })
});

const ERROR_CODES = Object.freeze({
  SESSION_REQUIRED: 'session_required',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  RATE_LIMITED: 'rate_limited',
  INVALID_REQUEST: 'invalid_request',
  LIMIT_EXCEEDED: 'limit_exceeded',
  LOCAL_ONLY: 'local_only',
  UNSUPPORTED_MEDIA: 'unsupported_media'
});

function capabilitiesFor(mode) {
  return CAPABILITIES[mode] || CAPABILITIES.cloud;
}

module.exports = { API_VERSION, CAPABILITIES, ERROR_CODES, capabilitiesFor };
