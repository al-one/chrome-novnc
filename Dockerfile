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
    GRASS_NODE=grass-community \
	HOMEPAGE=https://app.getgrass.io/register/?referralCode=IlJGw0ovdrhi_mk \
	NODEPAY=https://app.nodepay.ai/register?ref=O08ft2Ni9QxjmSG \
#Heroku No-Sleep Mode
	NO_SLEEP=false \
#Locale
	LANG=en_US.UTF-8 \
	LANGUAGE=en_US.UTF-8 \
	LC_ALL=C.UTF-8 \
	TZ="Asia/Shanghai"

COPY assets/ /
RUN chmod a+x /entrypoint.sh

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
RUN	apk add tzdata ca-certificates curl wget openssl bash python3 py3-requests sed unzip nss alsa-lib font-noto font-noto-cjk
RUN	apk add supervisor xvfb x11vnc websockify openbox chromium && \
# noVNC SSL certificate
	openssl req -new -newkey rsa:4096 -days 36500 -nodes -x509 -subj "/C=IN/O=Dis/CN=www.google.com" -keyout /etc/ssl/novnc.key -out /etc/ssl/novnc.cert > /dev/null 2>&1 && \
# TimeZone
	cp /usr/share/zoneinfo/$TZ /etc/localtime && \
	echo $TZ > /etc/timezone && \
# Wipe Temp Files
	apk del build-base curl wget unzip tzdata openssl && \
	rm -rf /var/cache/apk/* /tmp/*

ENTRYPOINT ["/entrypoint.sh", "supervisord", "-l", "/var/log/supervisord.log", "-c"]

CMD ["/config/supervisord.conf"]
