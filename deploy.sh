#!/usr/bin/env bash
# ============================================================================
# deploy.sh — развёртывание серверного приложения InfraControl.
#
# Два этапа:
#   1) ЛОКАЛЬНО: сверить окружение, собрать бандл (код + runtime-ресурсы,
#      при необходимости локальный node_modules) и залить через tar-over-ssh.
#   2) НА СЕРВЕРЕ: настроить окружение (dnf-пакеты, пользователь, .env,
#      systemd-сервис через ./start.sh, nginx-прокси с TLS) и запустить.
#
# Принципы:
#   * НАРУЖУ никто не видит Node (порт приложения слушает 127.0.0.1);
#     внешний доступ — только nginx (TLS, самоподписанный сертификат).
#   * Реальные пользователи/серверы заводим на сервере через веб-интерфейс;
#     дев-данные (data/, users.json, servers.json) на сервер НЕ летят.
#   * Компания-специфичные параметры — в ".env" (вне git, читается рядом).
#
# Использование:
#   ./deploy.sh              обычный деплой (push + настройка + старт)
#   ./deploy.sh push         только залить код, ничего не трогать на сервере
#   ./deploy.sh bundle       собрать офлайн-бандл локально (infracontrol-bundle.tgz),
#                            без заливки — можно передать вручную
#   ./deploy.sh --help/-h    справка
#
# Зависимости локально: ssh, tar, (опционально npm, если шлём node_modules).
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ---- .env общий для деплоя ------------------------------------------------
ENV_FILE="${DEPLOY_ENV:-$SCRIPT_DIR/.env}"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
else
  echo "Нет $ENV_FILE. Скопируйте .env.example -> .env и заполните." >&2
  exit 2
fi

# ---- Параметры (или значения по умолчанию) --------------------------------
DEPLOY_HOST="${DEPLOY_HOST:?DEPLOY_HOST не задан (напр. root@host)}"
SSH_OPTS=(-o BatchMode=yes -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new)

APP_DIR="${APP_DIR:-/opt/infracontrol}"
APP_USER="${APP_USER:-infracontrol}"
APP_USER_SHELL="${APP_USER_SHELL:-/usr/sbin/nologin}"
APP_PORT="${APP_PORT:-1845}"
APP_DEBUG="${APP_DEBUG:-0}"

NGINX_ENABLED="${NGINX_ENABLED:-1}"
NGINX_SERVER_NAME="${NGINX_SERVER_NAME:-$(printf '%s' "$DEPLOY_HOST" | cut -d@ -f2)}"
NGINX_CERTS_DIR="${NGINX_CERTS_DIR:-/etc/nginx/certs}"
NGINX_CERT="${NGINX_CERT:-$NGINX_CERTS_DIR/infracontrol.crt}"
NGINX_CERT_KEY="${NGINX_CERT_KEY:-$NGINX_CERTS_DIR/infracontrol.key}"
NGINX_SELF_SIGNED="${NGINX_SELF_SIGNED:-1}"
NGINX_HTTP_REDIRECT="${NGINX_HTTP_REDIRECT:-1}"

SHIP_NODE_MODULES="${SHIP_NODE_MODULES:-1}"
REBUILD_SQLITE="${REBUILD_SQLITE:-1}"
INSTALL_PKGS="${INSTALL_PKGS:-1}"
INSTALL_NODEJS_DEVEL="${INSTALL_NODEJS_DEVEL:-1}"

# ---- Перенос настроек (серверы + учётки) с рабочей машины ----------
# Только по явному флагу. Креды серверов зашифрованы AES-256-GCM ключом
# data/key.bin — без него перенос невозможен, поэтому тащим и его.
# Existing-настройки на сервере НЕ перетираются (кладутся только если
# файла на сервере ещё нет).
MIGRATE_SERVERS="${MIGRATE_SERVERS:-0}"
MIGRATE_USERS="${MIGRATE_USERS:-0}"

help() {
  sed -n '2,28p' "$0"
  exit 0
}

# ---- общие помощники --------------------------------------------------------
say()  { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }

# ============================================================================
# 1. Локальные проверки + сборка бандла
# ============================================================================
mode="${1:-full}"; case "$mode" in
  -h|--help) help ;;
  push)   ;;
  full)   ;;
  bundle) ;;
  *) echo "Неизвестный режим: $mode (bundle|push|full|--help)" >&2; exit 2 ;;
esac

for b in ssh tar; do command -v "$b" >/dev/null || { echo "Нет локально: $b" >&2; exit 1; }; done
if [ "$SHIP_NODE_MODULES" = 1 ] && [ ! -d node_modules ]; then
  echo "SHIP_NODE_MODULES=1, но node_modules отсутствует (соберите: npm install)." >&2
  exit 1
fi

say "Деплой на ${DEPLOY_HOST} -> ${APP_DIR} (режим: $mode)"
if [ "$mode" != bundle ]; then
  ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" 'true' 2>/dev/null \
    || { echo "Нет SSH-доступа к $DEPLOY_HOST" >&2; exit 1; }
fi

TMP_BUNDLE="$(mktemp)"
# Копируем файлы в фиксированную структуру (sudo в tar не нужен).
STAGE="$(mktemp -d)"
BUNDLE_OUT="${BUNDLE_OUT:-$SCRIPT_DIR/infracontrol-bundle.tgz}"
trap 'rm -rf "$STAGE"; rm -f "$TMP_BUNDLE"' EXIT

cp -r -- server web tools start.sh package.json package-lock.json "$STAGE"/
# runtime-ресурсы M2 (jar + уже извлечённая библиотека) — нужны для ISO;
# НЕ тащим data/ целиком (там дев-пользователи/серверы).
if [ -f raw/avr_irmc_s2.jar ]; then
  mkdir -p "$STAGE/raw"; cp raw/avr_irmc_s2.jar "$STAGE/raw/"
fi
if [ -d data/m2 ]; then cp -r data/m2 "$STAGE/data-m2"; fi   # распакуем в data/m2
if [ "$SHIP_NODE_MODULES" = 1 ]; then cp -r node_modules "$STAGE/node_modules"; fi

# Заголовки Node для офлайн-сборки better-sqlite3 (node-gyp иначе лезет в
# интернет за nodejs.org). Кэшируем в .cache (вне git), шлём в node-headers/.
if [ "$REBUILD_SQLITE" = 1 ]; then
  NODE_HEADERS_VERSION="${NODE_HEADERS_VERSION:-v24.18.0}"
  NCACHE="$SCRIPT_DIR/.cache/node-headers/$NODE_HEADERS_VERSION"
  if [ ! -d "$NCACHE/include" ]; then
    mkdir -p "$NCACHE"
    say "Скачиваю заголовки Node $NODE_HEADERS_VERSION (нужны для офлайн-сборки)..."
    curl -fsSL "https://nodejs.org/download/release/$NODE_HEADERS_VERSION/node-$NODE_HEADERS_VERSION-headers.tar.gz" \
      -o "$NCACHE/h.tgz"
    tar -C "$NCACHE" -xzf "$NCACHE/h.tgz" --strip-components=1
    rm -f "$NCACHE/h.tgz"
  fi
  cp -r "$NCACHE" "$STAGE/node-headers"
fi

# ---- перенос настроек с рабочей машины ----
if [ "$MIGRATE_SERVERS" = 1 ] || [ "$MIGRATE_USERS" = 1 ]; then
  mkdir -p "$STAGE/settings"
  if [ -f data/key.bin ]; then cp data/key.bin "$STAGE/settings/key.bin"; fi
  if [ "$MIGRATE_SERVERS" = 1 ] && [ -f data/servers.json ]; then
    cp data/servers.json "$STAGE/settings/servers.json"
  fi
  if [ "$MIGRATE_USERS" = 1 ] && [ -f data/users.json ]; then
    cp data/users.json "$STAGE/settings/users.json"
  fi
  srv="нет"; usr="нет"
  [ -f "$STAGE/settings/servers.json" ] && srv="да"
  [ -f "$STAGE/settings/users.json" ] && usr="да"
  warn "В бандле настроек: key.bin + servers.json ($srv) + users.json ($usr)"
fi

tar -C "$STAGE" -czf "$TMP_BUNDLE" .

if [ "$mode" = bundle ]; then
  cp -f "$TMP_BUNDLE" "$BUNDLE_OUT"
  echo "Офлайн-бандл собран: $BUNDLE_OUT"
  du -h "$BUNDLE_OUT"
  exit 0
fi

say "Заливаю бандл (~$(du -h "$TMP_BUNDLE" | cut -f1))..."
ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" "install -d '$APP_DIR'"

[[ ! -s "$TMP_BUNDLE" ]] && { echo "Пустой бандл" >&2; exit 1; }
cat "$TMP_BUNDLE" | ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" \
  "cd '$APP_DIR' && tar -xzf - && if [ -d data-m2 ]; then mkdir -p data/m2 && cp -r data-m2/. data/m2/ && rm -rf data-m2; fi"

if [ "$mode" = push ]; then echo "Push готов. Настройка окружения не выполнялась."; exit 0; fi

# ============================================================================
# 2. Настройка окружения на сервере
# ============================================================================
say "Настраиваю окружение на сервере..."

ssh "${SSH_OPTS[@]}" "$DEPLOY_HOST" \
  "APP_DIR='$APP_DIR' APP_USER='$APP_USER' APP_USER_SHELL='$APP_USER_SHELL' APP_PORT='$APP_PORT' APP_DEBUG='$APP_DEBUG' NGINX_ENABLED='$NGINX_ENABLED' NGINX_SERVER_NAME='$NGINX_SERVER_NAME' NGINX_CERTS_DIR='$NGINX_CERTS_DIR' NGINX_CERT='$NGINX_CERT' NGINX_CERT_KEY='$NGINX_CERT_KEY' NGINX_SELF_SIGNED='$NGINX_SELF_SIGNED' NGINX_HTTP_REDIRECT='$NGINX_HTTP_REDIRECT' INSTALL_PKGS='$INSTALL_PKGS' INSTALL_NODEJS_DEVEL='$INSTALL_NODEJS_DEVEL' REBUILD_SQLITE='$REBUILD_SQLITE' bash -s" <<'REMOTE'
set -euo pipefail

# ---------- пакеты ----------
if [ "$INSTALL_PKGS" = 1 ]; then
  echo "[deploy] dnf install (офлайн-репозитории DGK/base/updates)..."
  PKGS="nodejs npm unzip gcc gcc-c++ make"
  [ "$NGINX_ENABLED" = 1 ] && PKGS="$PKGS nginx"
  [ "$INSTALL_NODEJS_DEVEL" = 1 ] && PKGS="$PKGS nodejs-devel"
  dnf install -y $PKGS
fi

# ---------- приложение ----------
echo "[deploy] каталог $APP_DIR"
install -d -o root -g root "$APP_DIR"
# runtime-каталоги (владелец — пользователь сервиса)
grep -q "^$APP_USER:" /etc/passwd || useradd -r -s "$APP_USER_SHELL" -d "$APP_DIR" "$APP_USER"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data" "$APP_DIR/data/db" "$APP_DIR/data/iso" "$APP_DIR/logs" "$APP_DIR/screenshots"
chmod 755 "$APP_DIR/start.sh" || true

# ---------- перенос настроек (если включено и в бандле) ----------
# Кладём ТОЛЬКО если на сервере файла ещё нет — не перетираем существующее.
if [ -d "$APP_DIR/settings" ]; then
  for f in servers.json users.json key.bin; do
    if [ -f "$APP_DIR/settings/$f" ] && [ ! -f "$APP_DIR/data/$f" ]; then
      install -o "$APP_USER" -g "$APP_USER" -m 600 \
        "$APP_DIR/settings/$f" "$APP_DIR/data/$f"
      echo "[deploy] настройки: перенесён data/$f"
    fi
  done
  rm -rf "$APP_DIR/settings"
fi

# локальный .env приложения (контракты кода: PORT / IRMC_DEBUG)
cat > "$APP_DIR/.env" <<EOF
PORT=$APP_PORT
IRMC_DEBUG=$APP_DEBUG
EOF
chown "$APP_USER:$APP_USER" "$APP_DIR/.env" 2>/dev/null || true

# ---------- пересборка native-модуля под серверный Node ----------
if [ "$REBUILD_SQLITE" = 1 ]; then
  echo "[deploy] пересборка better-sqlite3 под серверный Node (офлайн, заголовки из бандла)..."
  if [ -d "$APP_DIR/node-headers" ]; then
    NODE_HEADERS_DIR="$APP_DIR/node-headers"
  else
    NODE_HEADERS_DIR="/usr"   # fallback: системные заголовки nodejs-devel
  fi
  ( cd "$APP_DIR" && npm_config_nodedir="$NODE_HEADERS_DIR" npm rebuild better-sqlite3 --build-from-source ) \
    || echo "[deploy] ! пересборка better-sqlite3 не удалась (будет видно при старте)"
  rm -rf "$APP_DIR/node-headers"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/node_modules" 2>/dev/null || true
fi

# ---------- systemd-сервис (запуск через ./start.sh) ----------
UNIT=/etc/systemd/system/infracontrol.service
cat > "$UNIT" <<EOF
[Unit]
Description=InfraControl backend service
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/start.sh
Restart=on-failure
RestartSec=5
KillMode=mixed
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable infracontrol.service >/dev/null 2>&1 || true

# ---------- nginx (TLS-прокси на 127.0.0.1:$APP_PORT) ----------
if [ "$NGINX_ENABLED" = 1 ]; then
  echo "[deploy] nginx reverse proxy -> 127.0.0.1:$APP_PORT"
  install -d -m 700 "$NGINX_CERTS_DIR"
  if [ "$NGINX_SELF_SIGNED" = 1 ] && [ ! -f "$NGINX_CERT" ]; then
    echo "[deploy] генерация самоподписанного сертификата"
    openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
      -keyout "$NGINX_CERT_KEY" -out "$NGINX_CERT" \
      -subj "/CN=$NGINX_SERVER_NAME" \
      -addext "subjectAltName=DNS:$NGINX_SERVER_NAME" >/dev/null 2>&1
    chmod 600 "$NGINX_CERT_KEY"
  fi
  # map для Upgrade-заголовка WebSocket (путь /vnc) — живёт в http-контексте
  cat > /etc/nginx/conf.d/00-infracontrol-ws.conf <<'NW'
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
NW

  # редирект 80 -> 443 (если включён)
  if [ "$NGINX_HTTP_REDIRECT" = 1 ]; then
    cat > /etc/nginx/conf.d/10-infracontrol-http.conf <<NW
server {
    listen 80;
    server_name $NGINX_SERVER_NAME;
    return 301 https://\$host\$request_uri;
}
NW
  else
    rm -f /etc/nginx/conf.d/10-infracontrol-http.conf
  fi

  # основной сайт: TLS + прокси всей http и WebSocket /vnc в Node
  cat > /etc/nginx/conf.d/20-infracontrol-site.conf <<NW
server {
    listen 443 ssl;
    http2 on;
    server_name $NGINX_SERVER_NAME;

    ssl_certificate     $NGINX_CERT;
    ssl_certificate_key $NGINX_CERT_KEY;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 0; # ISO-загрузка

    location / {
        proxy_http_version 1.1;
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
NW
  # не трогаем чужие конфиги; убираем только наши
  rm -f /etc/nginx/conf.d/10-infracontrol-site.conf /etc/nginx/conf.d/90-infracontrol-http.conf
  nginx -t
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl restart nginx
fi

# ---------- запуск ----------
systemctl restart infracontrol.service || true
sleep 2
echo ""
echo "[deploy] статус:"
systemctl --no-pager --full status infracontrol.service | sed -n '1,8p' || true
if systemctl is-active --quiet infracontrol.service; then
  echo "[deploy] OK. Локально (на сервере):"
  curl -fsS -o /dev/null -w '  http://127.0.0.1:%s HTTP %{http_code}\n' "$APP_PORT/api/me" 2>/dev/null \
    || echo "  (curl-проверка пропущена)"
else
  echo "[deploy] ! сервис не активен; журнал: journalctl -u infracontrol -n 50"
fi

# ---------- самопроверка наружу ----------
echo ""
echo "[deploy] проверка наружу (ничего лишнего не торчит):"
server_ip="$(ip -o -4 addr show | awk '/^[0-9]+: (en|eth|ens|enp)/{split($4,a,"/"); print a[1]; exit}')"
echo "  публичный IPv4 интерфейса: ${server_ip:-n/a}"
echo "  слушатели на ВНЕШНИХ адресах (ожидаем только 443):"
ss -ltn | awk 'NR>1 { addr=$4; n=split(addr,a,":");
  host=a[1]; for(i=2;i<=n;i++){host=host":"a[i]} ;
  if (host !~ /^127\./ && host !~ /^::/ && host ~ /\.|:/) print "    "$1"  "addr }' \
  | grep -vE '^\s+udp' | sort -u
echo "  слушает Node (ожидаем 127.0.0.1:$APP_PORT):"
ss -ltn | awk -v p="$APP_PORT" 'NR>1 && $4 ~ "^127\\.0\\.0\\.1:" p "$" {print "    "$1"  "$4}'
if [ "$NGINX_ENABLED" = 1 ]; then
  # https + наш серверный блок (без -k curl упрётся в самоподписанный — ок, это ожидаемо)
  code="$(curl -ksS -o /dev/null -w '%{http_code}' "https://127.0.0.1/" -H "Host: $NGINX_SERVER_NAME" 2>/dev/null || echo 000)"
  echo "  nginx https (self-signed, Host:$NGINX_SERVER_NAME): HTTP $code (ожидаем 200/301)"
fi
REMOTE

echo ""
echo "Готово. Внешний доступ: https://${NGINX_SERVER_NAME##*/} (сертификат самоподписанный,"
echo "при первом входе браузер предупредит). Реальных пользователей/серверы заводите"
echo "в веб-интерфейсе; работает: systemctl restart infracontrol, журнал: journalctl -u infracontrol -f"
