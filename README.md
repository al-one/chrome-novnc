# Chrome for Grass

[Grass](https://app.getgrass.io/register/?referralCode=IlJGw0ovdrhi_mk)为用户提供了一种利用闲置的网络资源进行挖矿的新途径。以下Chrome镜像专为Grass定制，内置Grass的Chrome扩展，帮助您轻松开始在Grass上的挖矿活动。
> 🚀 本镜像默认使用Grass社区节点，可以获得1.25倍的积分。通过指定`GRASS_NODE=grass-lite`环境变量可以切换默认扩展。

```bash
docker run \
    --name chrome-novnc \
    --restart unless-stopped \
    -p 8081:8080 \
    -e VNC_PASS=CHANGE_IT \
    -e VNC_RESOLUTION=1440x880 \
    -v /opt/containerd/lib/chromium:/root/.config/chromium \
    -d ghcr.nju.edu.cn/al-one/chrome:grass
```

操作步骤:
1. 执行上述命令安装Chrome Docker版，`CHANGE_IT`为远程访问密码
2. 在PC浏览器中打开`http://192.168.1.xxx:8081`，并输入刚才命令中的密码
3. 进入后点击`Don't sign in`，然后会自动打开Grass注册页面(邀请码: `IlJGw0ovdrhi_mk`)
4. 填完注册信息后，如果注册按钮灰色不可点击，需要多刷新几次或者使用特殊网络环境(人机验证需要)
5. 点击Chrome地址栏后面的扩展按钮，找到`Grass Community Node`/`Grass Extension`
6. 点击`LOGIN`，并登陆刚才注册的账号即可

## 邀请链接
- [Grass](https://app.getgrass.io/register/?referralCode=IlJGw0ovdrhi_mk)
- [NodePay](https://app.nodepay.ai/register?ref=O08ft2Ni9QxjmSG)
- [Gradient](https://app.gradient.network/signup?code=PUQCY5)
- DAWN Referral code: `0d7p58io`
