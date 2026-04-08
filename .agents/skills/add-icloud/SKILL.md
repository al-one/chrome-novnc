---
name: add-icloud
description: 添加 iCloud 隐私邮箱支持
---

## 需求描述
为Chrome插件`mpa4gpt`添加iCloud隐私邮箱支持

## 生成隐私邮箱
- `select-mail-provider`新增选项
- 在`background.js`中添加`fetchICloudEmail`方法
- 生成方法参考`https://github.com/rtunazzz/hidemyemail-generator/raw/refs/heads/main/icloud/hidemyemail.py`
- 所需的cookies从浏览器中获取 `X-APPLE`开头

# 抓取邮件验证码
- 新增文件: `assets/mpa4gpt/content/icloud.js`
- 邮箱页面: `https://www.icloud.com.cn/mail/` 邮件等主要内容位于iframe中
- 进入收件箱: `document.querySelector('.mailbox-list-item').click()`
- 邮件列表: `document.querySelectorAll('.thread-list-item')`
  发信时间: `.thread-timestamp`
  邮件主题: `.thread-subject` 验证码位于主题中
  发件人名称: `.thread-participants`
