# Chromium with NoVNC

## Installation
- ### Heroku
    [![Heroku](https://www.herokucdn.com/deploy/button.svg)](https://heroku.com/deploy?template=https://github.com/al-one/chrome-novnc)

- ### Manual
    ```sh
    docker run \
        --name chrome-novnc \
        -p 8080:8080 \
        -e VNC_PASS=CHANGE_IT \
        -d alone/chrome-novnc:latest
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


## 🌿 For [GetGrass](https://app.getgrass.io/register/?referralCode=IlJGw0ovdrhi_mk)
> Grass为用户提供了一种利用闲置的网络资源进行挖矿的新途径。以下Chrome镜像专为Grass定制，内置Grass的Chrome扩展，帮助您轻松开始在Grass上的挖矿活动。
```sh
docker run \
    --name chrome-novnc \
    -p 8081:8080 \
    -e VNC_PASS=CHANGE_IT \
    -d alone/chrome-novnc:grass
```

操作步骤:
1. 执行上述命令安装Chrome Docker版，`CHANGE_IT`为远程访问密码
2. 在PC浏览器中打开`http://192.168.1.xxx:8081`，并输入刚才命令中的密码
3. 进入后点击`Don't sign in`，然后会自动打开Grass注册页面
4. 填完注册信息后，如果注册按钮灰色不可点击，需要多刷新几次或者使用特殊网络环境(邀请码: `IlJGw0ovdrhi_mk`)
5. 登陆后点击Chrome地址栏后面的扩展按钮，找到`Grass Extension`
6. 点击`LOGIN`，并登陆刚才注册的账号即可
