/* Serves Code.gs (with mocked Google services) over HTTP, like a deployed Apps Script Web App.
   Usage: node live-server.js <adminKey>   → prints "PORT <n>" once listening.
   Like Apps Script, it answers with Access-Control-Allow-Origin:* but does NOT handle OPTIONS preflights,
   so any client request that triggers a preflight fails (that is what we want to catch). */
'use strict';
const http = require('http');
const { createEnv } = require('./mock-gas');

const key = process.argv[2] || 'live-test-key-0123456789';
const env = createEnv({ props: { ADMIN_KEY: key } });
env.run('setup');
const log = [];

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  log.push({ method: req.method, contentType: req.headers['content-type'] || '', path: req.url });
  if (url.pathname === '/__log') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(log)); }
  if (req.method === 'OPTIONS') { res.writeHead(405); return res.end(); }
  const send = out => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(out.getContent()); };
  if (req.method === 'GET') {
    const params = {}; url.searchParams.forEach((v, k) => { params[k] = v; });
    return send(env.sandbox.doGet({ parameter: params }));
  }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => send(env.sandbox.doPost({ postData: { contents: body, type: req.headers['content-type'] } })));
}).listen(0, '127.0.0.1', function () { console.log('PORT ' + this.address().port); });
