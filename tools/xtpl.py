from scapy.all import rdpcap, TCP, IP
import sys, json
pkts=rdpcap(sys.argv[1])
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
# вытащить ответные TX, отсортировав по размеру; собрать уникальные шаблоны ответов (до SCSI bulk)
seen={}
for t,dr,pl in ev:
    if dr!='TX': continue
    # только первые небольшие ответы (регулярные), без гигантских данных
    if len(pl)<=220:
        key=len(pl)
        seen.setdefault(key, pl.hex(' '))
for k in sorted(seen):
    print(f"TX len={k}: {seen[k]}")
