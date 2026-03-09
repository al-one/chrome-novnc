# Chromium with NoVNC

## Installation

- ### Manual
    ```sh
    docker run \
        --name chrome \
        -p 8080:8080 \
        -p 9222:9222 \
        -e VNC_PASS=CHANGE_IT \
        -e VNC_RESOLUTION=1440x880 \
        -e LAUNCH_OPTS=-remote-debugging-port=9221 --remote-debugging-address=0.0.0.0 --remote-allow-origins=* \
        -e EXTRA_COMMAND=socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9221 \
        -v /opt/containerd/lib/chromium:/root/.config/chromium \
        -d alone/chrome-novnc
    ```

## Environment variables:
|VARIABLE      |DESCRIPTION              |DEFAULT VALUE  |
|-------------:|:------------------------|:-------------:|
|VNC_PASS      |VNC Password             |CHANGE_IT      |
|VNC_TITLE     |VNC Session Title        |Chromium       |
|VNC_SHARED    |VNC Shared Mode          |false          |
|VNC_RESOLUTION|VNC Resolution           |1280x720       |
|PORT          |NoVNC HTTPS Port         |Heroku specific|
|APP_NAME      |Name of the app          |Heroku specific|
|NO_SLEEP      |Prevent app from sleeping|Heroku specific|
