'use strict';

function denied() {
  throw new Error('NETWORK_ACCESS_FORBIDDEN_IN_HARNESS_SAFETY_TEST');
}

global.fetch = denied;

const http = require('http');
const https = require('https');
http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
