// Lightweight, strictly time-bounded probe of an iRMC. Purpose: metadata AND
// reachability only — no KVM/screen. Used right after a reset to confirm the
// server is up and to grab identifying info (model, hostname, firmware hints)
// from the web-Server header and the <title> / prepared login realm.

import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import { permissiveTlsOptions } from './irmc.js';

function tcpProbe(host, port, targetTls, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const done = (obj) => { try { s.destroy(); } catch {} resolve(obj); };
    const s = targetTls
      ? tls.connect({ host, port, ...permissiveTlsOptions() }, () => done({ tls: true }))
      : net.connect({ host, port }, () => done({ tls: false }));
    s.on('error', (e) => done({ tls: targetTls, error: String(e && e.message || e) }));
    s.setTimeout(timeoutMs, () => done({ tls: targetTls, error: 'timeout' }));
  });
}

function httpGet(secure, host, port, path, headers, timeoutMs = 6000) {
  const mod = secure ? https : http;
  const u = new URL(`${secure ? 'https' : 'http'}://${host}:${port}${path}`);
  return new Promise((resolve) => {
    const done = (o) => { try { req.destroy(); } catch {} resolve(o); };
    const req = mod.get(u, secure ? { ...permissiveTlsOptions(), headers } : { headers }, (res) => {
      let body = '';
      res.setEncoding('latin1');
      res.on('data', (c) => { body += c; if (body.length > 40000) { done({ status: res.statusCode, headers: res.headers, body }); } });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', (e) => done({ error: String(e && e.message || e) }));
    req.setTimeout(timeoutMs, () => done({ error: 'timeout' }));
  });
}

export async function probe(cfg, timeoutMs = 6000) {
  const { host, username, secure = true, port = 443 } = cfg;
  const tlsOk = await tcpProbe(host, port, secure, timeoutMs);
  if (tlsOk.error) return { ok: false, host, port, secure, error: tlsOk.error };

  const hdrs = { 'User-Agent': 'Mozilla/5.0' };
  if (username) hdrs.Authorization = 'Basic ' + Buffer.from(`${username}:${cfg.password || ''}`).toString('base64');
  const res = await httpGet(secure, host, port, '/', hdrs, timeoutMs);
  if (res.error) return { ok: false, host, port, secure, error: res.error, reachable: true };

  const h = res.headers || {};
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(res.body || '');
  const realm = /realm="([^"]+)"/i.exec((h['www-authenticate'] || '') + '');
  return {
    ok: true,
    host, port, secure,
    reachable: true,
    httpStatus: res.status,
    server: h.server,
    authScheme: (h['www-authenticate'] || '').split(' ')[0].trim(),
    realm: realm ? realm[1] : undefined,
    title: title ? title[1].trim() : undefined,
    length: (res.body || '').length,
  };
}
