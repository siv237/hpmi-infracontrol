#!/usr/bin/env node
// Чистый Node-клиент storage-протокола iRMC (реверс 10.0b).
// Заменяет нативный движок M2: сам поднимает outbound-канал к iRMC:80,
// проходит handshake и отвечает на MMC/SCSI-команды (INQUIRY, READ10, ...).
// Формат — wiki/knowledge/irmc-storage.md.
// Проверено по авторитетному захвату (/tmp/kilo/urs2.pcap): магия c обe стороны
// ОДИНАКОВА `00 80 b5 09 00 10 00 00`; INQUIRY payload = 05 00 00 32 1f...;
// рамка данных READ10 и инкапсуляция под-ответов — см. ниже.
import net from 'node:net';
import fs from 'node:fs';

const MAGIC = Buffer.from([0x00,0x80,0xb5,0x09,0x00,0x10,0x00,0x00]); // мы→iRMC (ответы)
const CMAG0 = Buffer.from([0x00,0x90,0xb5,0x09,0x00,0x10,0x00,0x00]); // iRMC→мы (команды)
const CMAG1 = Buffer.from([0x00,0x80,0xb5,0x09,0x00,0x10,0x00,0x00]); // запасной вариант команды
const H = (e3)=>{ const b=Buffer.from([0xe3,0x7f,0x00,0x00]); return e3?b:Buffer.from(b); };
const HEAP = Buffer.from([0xe3,0x7f,0x00,0x00]);
const HD = (hex) => Buffer.from(hex.replace(/\s+/g,''), 'hex');

// Реальный INQUIRY payload (36Б) из батча M2: type=0x05 CD-ROM, resp-fmt 0x32,
// addl-len 0x1f, vendor/product/rev.
const INQ = Buffer.from([
  0x05,0x00,0x00,0x32,0x1f,0x00,0x00,0x00,
  0x46,0x75,0x6a,0x69,0x74,0x73,0x75,0x20,             // "Fujitsu "
  0x52,0x65,0x6d,0x6f,0x74,0x65,0x20,0x49,0x73,0x6f, // "Remote Iso "
  0x43,0x44,0x52,0x4f,0x4d,                             // "CDROM"
  0x32,0x2e,0x30,0x34,0x00,0x00,0x00,0x00,             // "2.04\0\0\0\0"
]);

// Инкапсуляция одного под-ответа (по батчу INQUIRY frame#0): dlen в [8], idx в
// [12..15], opaque-хэндлы e3 7f 00 00 / 90 xx xx xx — iRMC не разыменовывает.
function envelope(dlen, idx) {
  const h = Buffer.alloc(64);
  MAGIC.copy(h, 0);
  h.writeUInt8(0x08, 8);                 // активная длина (dlen сверх магии)
  h.writeUInt32LE(idx, 12);
  HEAP.copy(h, 20); h.writeUInt32LE(dlen, 24);
  HEAP.copy(h, 28);
  Buffer.from([0x90,0x57,0x1c,0x8f]).copy(h, 40); HEAP.copy(h, 44);
  Buffer.from([0x90,0x60,0x41,0x8d]).copy(h, 48); HEAP.copy(h, 52);
  Buffer.from([0xad,0x0c,0x02,0x00,0x00,0x00,0x01,0x00]).copy(h, 56);
  return h;
}

// Рамка данных READ10 (по большой передаче @tx 1112827): magic + dlen8 + idx +
// opaque + дважды `00 04 84 00 00 02 00 00` + idx+1, затем секторы ISO.
function read10Frame(idx) {
  const lead = Buffer.from([
    0x08,0x00,0x00,0x00, 0,0,0,0, 0,0,0,0,
    0x00,0x00,0x00,0x00,
    0xe3,0x7f,0x00,0x00,
    0x08,0x00,0x00,0x00, 0xe3,0x7f,0x00,0x00,
    0x00,0x04,0x84,0x00,0x00,0x02,0x00,0x00,
    0x30,0x61,0x10,0x80, 0xe3,0x7f,0x00,0x00,
    0xc0,0x2c,0x00,0x80, 0xe3,0x7f,0x00,0x00,
    0xf4,0x0d,0x02,0x00,0x00,0x00,0x01,0x00,
    0x00,0x04,0x84,0x00,0x00,0x02,0x00,0x00,
    0x00,0x00,0x00,0x00, 0xe3,0x7f,0x00,0x00,
    0x01,0x00,0x00,0x00,
  ]);
  const head = Buffer.alloc(8);
  MAGIC.copy(head,0);
  head.writeUInt32LE(idx, 12);           // idx[12..15]
  // idx+1 после зарезервированного поля
  const tail = Buffer.alloc(8,0); tail.writeUInt32LE(idx+1, 0);
  return Buffer.concat([head, lead, tail]);
}

export class StorClient {
  constructor({ host, port = 80, sharePath, file, log = console.log }) {
    this.host=host; this.port=port; this.sharePath=sharePath; this.file=file;
    this.log=log; this.sock=null; this.buf=Buffer.alloc(0); this.idx=1;
    this.fileHandle=null; this.meta=null; this.pathSent=false;
    this.lastRx=Date.now(); this.aliveTimer=null;
  }

  async open(second=false) {
    if (!this.fileHandle && !second) this.fileHandle=await fs.promises.open(this.file,'r');
    if (!second) this._startKeepAlive();
    return new Promise((res,rej)=>{
      const s=net.connect(this.port,this.host);
      (second? this.meta=this.meta??{}: this.sock=s);
      if (second) this.meta.sock=s;
      s.on('connect',()=>res());
      s.on('error',rej);
      s.on('data',(d)=>this._onData(d, second));
      s.setTimeout(25000,()=>{try{s.end();}catch{}});
    });
  }

  // Keep-alive: если от iRMC тихо >25с — шлём подтверждение активности (f2)
  // на метаканале, чтобы вирт. USB не ушёл в offline по таймауту прошивки.
  _startKeepAlive(){
    if(this.aliveTimer) return;
    this.aliveTimer=setInterval(()=>{
      const idle=Date.now()-this.lastRx;
      if(idle>25000){
        this._log('idle '+Math.round(idle/1000)+'s — keep-alive (f2 на метаканале)');
        if(this.meta&&this.meta.sock&&!this.meta.sock.destroyed) this.sendClientConfirm();
      }
    },20000);
    this.aliveTimer.unref?.();
  }

  _log(m){ try{this.log('[stor] '+m);}catch{} }

  async handshake(){
    this.sock.write(HD('d2 02 00 01 00 01 cd 37'));
    this._log('signature sent; waiting Fujitsu banner');
    await new Promise((r)=>{ this._banner=r;
      setTimeout(()=>{ if(this._banner){const c=this._banner;this._banner=null;c();} },6000); });
    const u=Buffer.from(this.sharePath,'utf16le');
    const msg=Buffer.alloc(1028);
    msg[0]=0x48; msg[1]=0x00; msg[2]=0x0b; msg[3]=0xff;
    u.copy(msg,4);
    this.sock.write(msg);
    this.pathSent=true;
    this._log('path sent ('+this.sharePath+')');
  }

  // клиентская подтверждение на втором канале (M2: "Sending client confirmation")
  sendClientConfirm(){
    if(!this.meta||!this.meta.sock) return;
    const b=Buffer.from([0xf2,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x08,0x00,0x08,0x00,
      0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00]);
    this.meta.sock.write(b);
    this._log('client-confirm f2 sent on meta channel');
  }

  _onData(d, second){
    if(second){
      this._log('META RX '+d.length+'B '+d.subarray(0,32).toString('hex'));
      if(d.includes(Buffer.from([0xf0,0xfa,0x02]))) this.sendClientConfirm();
      return;
    }
    this._log('RX '+d.length+'B '+d.subarray(0,48).toString('hex'));
    this.lastRx=Date.now();
    this.buf=Buffer.concat([this.buf,d]);
    if(this._banner && this.buf.includes(Buffer.from('Fujitsu'))){const c=this._banner;this._banner=null;c();}
    this._parse();
  }

  _parse(){
    for(;;){
      let i=this.buf.indexOf(CMAG0);
      const use=CMAG0;
      if(i<0){ i=this.buf.indexOf(CMAG1); }
      if(i<0) return;
      const dlen=this.buf[i+8];
      if(dlen>0x40){ this.buf=this.buf.subarray(i+1); continue; }
      const frameLen=64+dlen;                // подтв. живьём: INQUIRY dlen=6 -> 70Б
      if(this.buf.length < i+frameLen) return;
      const cdb=this.buf.subarray(i+64, i+64+dlen);
      const idx=this.buf.readUInt32LE(i+12);
      this.buf=this.buf.subarray(i+frameLen);
      this._handle(cdb, idx);
    }
  }

  async _handle(cdb, idx){
    const op=cdb[0]; const send=(d)=>this.sock.write(d);
    this._log(`cmd ${cdb.toString('hex')} idx=${idx}`);
    if(op===0x12){ // INQUIRY
      send(Buffer.concat([envelope(36, idx), INQ]));
      this._log('-> INQUIRY 36B');
    } else if(op===0x25){ // READ CAPACITY
      const size=(await this.fileHandle.stat()).size;
      const last=Math.floor(size/2048)-1;
      const d=Buffer.alloc(8);
      d.writeUInt32BE(last,0); d.writeUInt32BE(2048,4);
      send(Buffer.concat([envelope(8,idx), d]));
      this._log('-> READ CAPACITY last='+last);
    } else if(op===0x28){ // READ10: данные секторов
      const lba=cdb.readUInt32BE(2); const xfer=cdb.readUInt16BE(7);
      const len=xfer*2048; const buf=Buffer.alloc(len);
      await this.fileHandle.read(buf,0,len,lba*2048);
      send(Buffer.concat([read10Frame(idx), buf]));
      this._log(`-> READ10 LBA=${lba} x${xfer} -> ${len}B (frame idx=${idx})`);
    } else if(op===0x1b){ // START/STOP (0x1b) — пустое ок
      send(envelope(0x08,idx));
      this._log('-> op 0x1b (0x08)');
    } else if(op===0x03){ // REQUEST SENSE: мгновенно "no sense / ok" (18Б)
      const s=Buffer.alloc(18);
      s[0]=0x70; s[7]=0x0a;                  // Fixed format, sense key 0 (no sense)
      send(Buffer.concat([envelope(18, idx), s]));
      this._log('-> REQUEST SENSE ok (keep-alive ack)');
    } else if(op===0x00){ // TEST UNIT READY
      send(envelope(0x08,idx));
      this._log('-> TUR ok (keep-alive ack)');
    } else if(op===0x4a){ // GET EVENT STATUS NOTIFICATION: минимальный
      // profile DVD (0x10) / CD (0x00 низкий байт), события нет
      send(Buffer.concat([envelope(0x0c, idx), Buffer.from([0x00,0x10,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00])]));
      this._log('-> GET EVENT ok (keep-alive ack)');
    } else if(op===0x2a){ // WRITE10 — не поддерживаем, ok
      send(envelope(0x08,idx));
    } else {
      // MODE SENSE(22)/READ TOC(43)/GET CONFIG(46)/READ DISC(51)/TRACK(52) и т.п.
      send(envelope(0x0c, idx)); // общий 0x0c-пустышка как в малых кадрах M2
      this._log('-> stub 0x'+op.toString(16)+' (0x0c)');
    }
  }

  close(){ try{this.sock?.end();}catch{} try{this.meta?.sock?.end();}catch{} try{this.fileHandle?.close();}catch{}
    if(this.aliveTimer){ clearInterval(this.aliveTimer); this.aliveTimer=null; } }
}
