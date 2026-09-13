#!/usr/bin/env python3
# Загрузчик нативного движка M2 из легаси-вьювера (avr_irmc_s2.jar, GPL).
# Повторяет NativeInterface2: пишет StorageServer.Port, делает dlopen .so,
# ждёт StorageServer.ActualPort и остаётся жить — сервер M2 работает
# в собственных потоках библиотеки. Формат см. wiki/knowledge/irmc-storage.md
import ctypes
import os
import sys
import time

run_dir = os.path.abspath(sys.argv[1])
want_port = sys.argv[2] if len(sys.argv) > 2 else "5901"
os.chdir(run_dir)

with open("StorageServer.Port", "w") as f:
    f.write(want_port)
try:
    os.remove("StorageServer.ActualPort")
except FileNotFoundError:
    pass

ctypes.CDLL(os.path.join(run_dir, "LIBM2-64.SO"), mode=os.RTLD_NOW)

port = ""
for _ in range(40):
    try:
        with open("StorageServer.ActualPort") as f:
            port = f.read().strip()
    except FileNotFoundError:
        port = ""
    if port:
        break
    time.sleep(0.25)

print("M2_PORT=%s" % port, flush=True)
if not port:
    sys.exit(1)

while True:
    time.sleep(3600)
