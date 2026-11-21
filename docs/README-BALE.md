# پل بله — بایگانی مستندات مقاطع پمپ

رانندگان پمپ عکس مستندات مقاطع را در گروه بله می‌فرستند. این سرویس آن عکس‌ها را
جمع می‌کند و اپ آن‌ها را در «فایل عملکرد» هر پمپ بایگانی می‌کند.

## چه چیزی لازم است

۱. یک **ربات بله**: در بله سراغ BotFather برو و یک ربات بساز؛ توکنش را بردار.
۲. ربات را به **گروه رانندگان پمپ** اضافه کن و **ادمینش کن**. اگر ادمین نباشد
   ممکن است فقط دستورها را ببیند و عکس‌ها به دستش نرسد.
۳. سرویس باید روی **سرور ایران** (`37.202.225.180`) نصب شود، چون `bale.ai` از
   سرور خارج در دسترس نیست — همان جایی که `sobhan-gps` نصب است.

## محدودیت‌هایی که باید بدانی

- ربات فقط پیام‌هایی را می‌بیند که **بعد از اضافه شدنش** فرستاده شده‌اند. عکس‌های
  قبلی را باید در گروه فوروارد کنید یا دستی در اپ بارگذاری کنید.
- عکسی که راننده با کیفیت پایین بفرستد، با همان کیفیت بایگانی می‌شود.
- اگر در متن پیام نام یا پلاک پمپ نباشد، سند «بی‌پمپ» می‌ماند و در اپ با یک
  انتخاب به پمپ وصل می‌شود؛ اپ پمپ را حدس نمی‌زند.

## نصب

```bash
sudo mkdir -p /opt/sobhan/bale
sudo cp bale-bridge.js /opt/sobhan/
sudo tee /opt/sobhan/bale.env >/dev/null <<'ENV'
BALE_TOKEN=توکن_ربات_بله
APP_TOKEN=همان_رمزی_که_در_اپ_می‌گذاری
PORT=8790
DIR=/opt/sobhan/bale
# CHAT_ID=-100xxxxxxxx   # اگر فقط یک گروه مدنظر است
POLL_SEC=60
ENV
sudo chmod 600 /opt/sobhan/bale.env

sudo tee /etc/systemd/system/sobhan-bale.service >/dev/null <<'SRV'
[Unit]
Description=Sobhan Bale bridge
After=network-online.target

[Service]
EnvironmentFile=/opt/sobhan/bale.env
ExecStart=/usr/bin/node /opt/sobhan/bale-bridge.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
SRV

sudo systemctl daemon-reload && sudo systemctl enable --now sobhan-bale
curl -s localhost:8790/bale/health
```

`health` باید `{"ok":true,"token":true,...}` بدهد. اگر `token:false` بود، توکن ربات
در `bale.env` نیامده است.

## وصل کردن اپ

در اپ → تب «گزارش و نمودار» → زیربخش «پمپ» → دکمه‌ی **«تنظیم پل بله»**: آدرس
(`http://37.202.225.180:8790`) و همان `APP_TOKEN` را وارد کن. بعد **«دریافت اسناد از
گروه بله»**.

## نشانی‌ها

| نشانی | کار |
| --- | --- |
| `GET /bale/health` | وضعیت سرویس (بدون رمز) |
| `GET /bale/docs?since=<ms>&limit=` | فهرست اسناد تازه، فقط اطلاعات متنی |
| `GET /bale/file/<uid>` | خود تصویر |

هر دو نشانی آخر هدر `x-app-token` می‌خواهند. سرویس هیچ چیزی به گروه نمی‌فرستد و
فقط می‌خواند.
