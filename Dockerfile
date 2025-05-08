FROM alpine:3.19.1

LABEL AboutImage "Alpine_Chromium_NoVNC"

LABEL Maintainer "Alone <hi@anlo.ng>"

#VNC Server Password
ENV	VNC_PASS="CHANGE_IT" \
#VNC Server Title(w/o spaces)
	VNC_TITLE="Chromium" \
#VNC Resolution(720p is preferable)
	VNC_RESOLUTION="1280x720" \
#VNC Shared Mode
	VNC_SHARED=false \
#Local Display Server Port
	DISPLAY=:0 \
#NoVNC Port
	NOVNC_PORT=$PORT \
	PORT=8080 \
#Config
	HOMEPAGE=https://app.getgrass.io/register/?referralCode=IlJGw0ovdrhi_mk \
	NODEPAY=https://app.nodepay.ai/register?ref=O08ft2Ni9QxjmSG \
	GRADIENT=https://app.gradient.network/signup?code=PUQCY5 \
    GRASS_NODE=grass-community \
    GRASS_COMMUNITY_VERS="https://files.getgrass.io/file/grass-extension-upgrades/extension-installer-latest.json" \
#Heroku No-Sleep Mode
	NO_SLEEP=false \
#Locale
	LANG=en_US.UTF-8 \
	LANGUAGE=en_US.UTF-8 \
	LC_ALL=C.UTF-8 \
	TZ="Asia/Shanghai"

ENV LOAD_EXTENSION=/root/${GRASS_NODE},/root/nodepay,/root/gradient,/root/dawn

COPY assets/ /
RUN chmod a+x /entrypoint.sh

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
RUN	apk add tzdata ca-certificates bash curl wget unzip jq sed openssl python3 py3-requests nss alsa-lib font-noto font-noto-cjk
RUN set -x; \
    cd /root; \
    EXT_PATH=$(curl -s "$GRASS_COMMUNITY_VERS" | jq -r '.platforms."linux-x86_64".url'); \
    wget -O grass-community.zip $EXT_PATH; \
    unzip grass-community.zip; \
    unzip -o grass-*.crx -d ./grass-community; \
    rm -f grass-community.zip; \
    python3 crx-dl.py https://chromewebstore.google.com/detail/grass-lite-node/ilehaonighjijnmpnagapkhpcdbhclfg -o grass-lite.crx; \
    unzip -o grass-lite.crx -d ./grass-lite; \
    python3 crx-dl.py https://chromewebstore.google.com/detail/nodepay-extension/lgmpfmgeabnnlemejacfljbmonaomfmm -o nodepay.crx; \
    unzip -o nodepay.crx -d ./nodepay; \
    python3 crx-dl.py https://chromewebstore.google.com/detail/gradient-sentry-node/caacbgbklghmpodbdafajbgdnegacfmo -o gradient.crx; \
    unzip -o gradient.crx -d ./gradient; \
    python3 crx-dl.py https://chromewebstore.google.com/detail/dawn-validator-chrome-ext/fpdkjdnhkakefebpekbdhillbhonfjjp -o dawn.crx; \
    unzip -o dawn.crx -d ./dawn; \
    rm -f *.crx

RUN	apk add supervisor xvfb x11vnc websockify openbox chromium && \
# noVNC SSL certificate
	openssl req -new -newkey rsa:4096 -days 36500 -nodes -x509 -subj "/C=IN/O=Dis/CN=www.google.com" -keyout /etc/ssl/novnc.key -out /etc/ssl/novnc.cert > /dev/null 2>&1 && \
# TimeZone
	cp /usr/share/zoneinfo/$TZ /etc/localtime && \
	echo $TZ > /etc/timezone && \
# Wipe Temp Files
	apk del build-base curl wget unzip jq tzdata openssl && \
	rm -rf /var/cache/apk/* /tmp/*

ENTRYPOINT ["/entrypoint.sh", "supervisord", "-l", "/var/log/supervisord.log", "-c"]

CMD ["/config/supervisord.conf"]
