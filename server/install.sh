#!/usr/bin/env bash
# نصب سرویس‌های دستیار سبحان بتن
#
#   sudo ./install.sh            هر دو سرویس (همگام‌سازی و پل بله)
#   sudo ./install.sh sync       فقط همگام‌سازی
#   sudo ./install.sh bale       فقط پل بله
#
# چند بار اجرا کردنش اشکالی ندارد: فایل‌های تنظیمات (sync.env و bale.env) را
# هرگز بازنویسی نمی‌کند، فقط اگر نبودند از نمونه می‌سازد.
set -euo pipefail

BASE=/opt/sobhan
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ $# -eq 0 ]; then WANT=(sync bale); else WANT=("$@"); fi

red() { printf '\033[31m%s\033[0m\n' "$*"; }
grn() { printf '\033[32m%s\033[0m\n' "$*"; }
ylw() { printf '\033[33m%s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { red "با sudo اجرا کن."; exit 1; }
command -v node >/dev/null || { red "node نصب نیست. اول نصبش کن:  apt install -y nodejs"; exit 1; }
ylw "نسخه node: $(node -v)"
command -v systemctl >/dev/null || { red "systemd پیدا نشد؛ این اسکریپت برای سرور systemd است."; exit 1; }

mkdir -p "$BASE"
NEWENV=""

install_one() {           # $1=نام سرویس  $2=فایل js  $3=فایل env  $4=پورت
  local name="$1" js="$2" env="$3" port="$4"
  [ -f "$SRC/$js" ] || { red "فایل $js در $SRC نیست."; exit 1; }

  install -m 644 "$SRC/$js" "$BASE/$js"
  grn "کپی شد: $BASE/$js"

  if [ -f "$BASE/$env" ]; then
    ylw "تنظیمات موجود دست‌نخورده ماند: $BASE/$env"
  else
    install -m 600 "$SRC/$env.example" "$BASE/$env"
    NEWENV="$NEWENV$BASE/$env\n"
    ylw "تنظیمات تازه ساخته شد: $BASE/$env  (باید پر شود)"
  fi
  chmod 600 "$BASE/$env"

  install -m 644 "$SRC/$name.service" "/etc/systemd/system/$name.service"
  systemctl daemon-reload
  systemctl enable "$name" >/dev/null 2>&1 || true

  # اگر رمز خالی است سرویس را راه نمی‌اندازیم تا کاربر اول تنظیمش کند
  if grep -qE '^APP_TOKEN=.+' "$BASE/$env"; then
    systemctl restart "$name"
    sleep 2
    if systemctl is-active --quiet "$name"; then
      grn "$name بالا آمد."
      curl -fsS --max-time 5 "http://127.0.0.1:$port/${name#sobhan-}/health" && echo || ylw "پاسخ health نیامد؛ با journalctl -u $name -n 40 ببین."
    else
      red "$name بالا نیامد:"; journalctl -u "$name" -n 20 --no-pager || true
    fi
  else
    ylw "$name نصب و فعال شد ولی راه نیفتاد، چون APP_TOKEN در $BASE/$env خالی است."
  fi
  echo
}

for w in "${WANT[@]}"; do
  case "$w" in
    sync) install_one sobhan-sync sync-server.js  sync.env 8788 ;;
    bale) mkdir -p "$BASE/bale/files"
          install_one sobhan-bale bale-bridge.js  bale.env 8790 ;;
    *)    red "ورودی ناشناخته: $w  (sync یا bale)"; exit 1 ;;
  esac
done

if [ -n "$NEWENV" ]; then
  echo "─────────────────────────────────────────────"
  ylw "قدم بعدی: این فایل‌ها را پر کن و بعد سرویس را دوباره راه بیانداز"
  printf '%b' "$NEWENV" | while read -r f; do [ -n "$f" ] && echo "    nano $f"; done
  echo
  echo "یک رمز تصادفی:   openssl rand -hex 24"
  echo "راه‌اندازی مجدد:  systemctl restart sobhan-sync sobhan-bale"
  echo "─────────────────────────────────────────────"
fi

echo "پورت‌ها را در فایروال باز کن (اگر ufw داری):"
for w in "${WANT[@]}"; do
  [ "$w" = sync ] && echo "    ufw allow 8788/tcp"
  [ "$w" = bale ] && echo "    ufw allow 8790/tcp"
done
