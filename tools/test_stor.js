#!/usr/bin/env node
import { StorClient } from '../server/stor.js';
const client = new StorClient({
  host: '10.67.17.101',
  port: 80,
  sharePath: '/home/siv/proj/IPMI-Viewer/data/iso/ae3098f9-4471-446e-8e4f-bda5d74ef09b',
  file: '/home/siv/proj/IPMI-Viewer/data/iso/ae3098f9-4471-446e-8e4f-bda5d74ef09b',
});
try {
  await client.open();
  console.log('TCP connected');
  await client.handshake();
  console.log('handshake done');
  await new Promise(r => setTimeout(r, 15000));
  console.log('--- done (15s) ---');
  client.close();
} catch (e) { console.error('ERR', e && e.message); client.close(); }
