#!/usr/bin/env python3
# Разбор захвата M2<->iRMC (pcap) в карту «запрос -> ответ» для чистой
# Node-реализации. Требует scapy. Реверс протокола (wiki/knowledge/irmc-storage.md).
import sys, struct, json
from scapy.all import rdpcap, TCP, IP

MAGIC = b'\x00\x80\xb5\x09\x00\x10\x00\x00'
LEAD  = b'\x00\x00\x00\x00\x00\x00'
BMC='10.67.17.101'

def split_frames(stream):
    """делит поток на кадры по магии; возвращает список (start, end, bytes)."""
    occ=[]; pos=0
    while True:
        i=stream.find(MAGIC, pos)
        if i<0: break
        occ.append(i); pos=i+1
    return occ, stream

def parse_cdb(fr):
    """из 92/74-байт кадра-команды: opcode/dlen/index."""
    # индекс на 12..15, длина CDB на [8]
    dlen = fr[8] & 0xff if len(fr)>=9 else 0
    index = struct.unpack('<I', fr[12:16])[0] if len(fr)>=16 else 0
    # CDB ищем с начала полезной части (по не-нулевым байтам)
    cdb = fr[dlen_start(fr):][:16]
    return dlen, index, cdb, fr

def dlen_start(fr):
    # после leading нулей; в первых кадрах CDB идёт со смещения, где байт !=0 после envelope
    for i in range(0, min(24,len(fr))):
        if fr[i]!=0: return i
    return 0

def main(path):
    pkts=rdpcap(path)
    rx=bytearray(); tx=bytearray()
    for p in pkts:
        if not(p.haslayer(IP) and p.haslayer(TCP)): continue
        s=str(p[IP].src); d=str(p[IP].dst); sp=p[TCP].sport; dp=p[TCP].dport
        pl=bytes(p[TCP].payload)
        if not pl: continue
        if d==BMC and dp==80 and sp==45612: tx.extend(pl)
        elif s==BMC and sp==80 and dp==45612: rx.extend(pl)
    rx=bytes(rx); tx=bytes(tx)
    rocc,_=split_frames(rx); tocc,_=split_frames(tx)
    print(f"RX frames={len(rocc)} TX frames={len(tocc)}")
    # карта READ10: для каждой RX-команды READ10 (0x28) показать LBA, index, и следующий TX-кадр
    out=[]
    for ri,r in enumerate(rocc):
        e=rocc[ri+1] if ri+1<len(rocc) else min(r+200,len(rx))
        fr=rx[r:e]
        # найти opcode: первые 6-10 байт после envelope
        # мини-find: ищем READ10 как '28 00 00'
        j=fr.find(b'\x28\x00\x00')
        if j<0: continue
        lba=struct.unpack('>I', fr[j+2:j+6])[0]
        xfer=(fr[j+7]<<8)|fr[j+8] if len(fr)>=j+9 else 0
        idx=struct.unpack('<I', fr[12:16])[0]
        out.append({'ri':ri,'index':idx,'lba':lba,'xfer':xfer,'tx_off':tocc[0] if tocc else None})
        # первый TX-кадр после этого RX по времени не ализируем (потоки разд.), только дамп
    # дамп первых 40 READ10
    for o in out[:40]:
        print(f"  READ10 ri#{o['ri']} idx=0x{o['index']:x} LBA=0x{o['lba']:x} xfer={o['xfer']}")
    # по TX: вытащить INQUIRY-ответ (строка Fujitsu) и его 64Б заголовок
    j=tx.find(b'Fujitsu')
    if j>=0:
        print(f"\nINQUIRY 'Fujitsu' в TX @ {j}; заголовок 64Б до: {tx[j-64:j].hex(' ')}")
        print(f"INQUIRY payload (40Б): {tx[j:j+40].hex(' ')}")
    return out

if __name__=='__main__':
    main(sys.argv[1] if len(sys.argv)>1 else '/tmp/kilo/urs2.pcap')
