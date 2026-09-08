from scapy.all import rdpcap, TCP, IP
import sys
pkts=rdpcap(sys.argv[1] if len(sys.argv)>1 else '/tmp/kilo/urs2.pcap')
BMC='10.67.17.101'
ev=[]
for p in pkts:
    if not(p.haslayer(IP) and p.haslayer(TCP)): continue
    s=str(p[IP].src);d=str(p[IP].dst);sp=p[TCP].sport;dp=p[TCP].dport
    pl=bytes(p[TCP].payload)
    if not pl: continue
    if d==BMC and dp==80 and sp==45612: ev.append((p.time,'TX',pl))
    elif s==BMC and sp==80 and dp==45612: ev.append((p.time,'RX',pl))
ev.sort(key=lambda x:x[0])
# первые сообщения из канала данных (руки): до первого SCSI
n=0
for t,dir,p in ev:
    if n>14: break
    print(f"--- [{dir}] {len(p)}B @ {t:.3f}")
    show=p if len(p)<=96 else p[:96]
    print(show.hex(' '))
    n+=1
