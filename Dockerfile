FROM alpine:3

ENV	VNC_PASS="CHANGE_IT" \
	VNC_TITLE="Chromium" \
	VNC_RESOLUTION="1280x720" \
	VNC_SHARED=false \
	DISPLAY=:0 \
	PORT=8080 \
	NO_SLEEP=false \
	LANG=en_US.UTF-8 \
	LANGUAGE=en_US.UTF-8 \
	LC_ALL=C.UTF-8 \
	LAUNCH_OPTS="--load-extension=/mpa4gpt" \
	TZ="Asia/Shanghai"

# RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.ustc.edu.cn/g' /etc/apk/repositories
RUN	apk add tzdata ca-certificates bash curl wget unzip jq sed openssl python3 py3-requests socat nss alsa-lib font-noto font-noto-cjk
RUN	apk add supervisor xvfb x11vnc websockify openbox chromium && \
	openssl req -new -newkey rsa:4096 -days 36500 -nodes -x509 -subj "/C=IN/O=Dis/CN=www.google.com" -keyout /etc/ssl/novnc.key -out /etc/ssl/novnc.cert > /dev/null 2>&1 && \
	cp /usr/share/zoneinfo/$TZ /etc/localtime && \
	echo $TZ > /etc/timezone && \
	apk del build-base wget tzdata openssl && \
	rm -rf /var/cache/apk/* /tmp/*

COPY assets/ /
RUN chmod a+x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh", "supervisord", "-l", "/var/log/supervisord.log", "-c"]
CMD ["/etc/supervisord.conf"]
HEALTHCHECK --interval=1m --start-period=10s CMD nc -zn 0.0.0.0 $PORT || exit 1
