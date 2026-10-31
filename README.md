# dsh-hykb-whale · 快爆小号

> 仅供学习交流。使用者须自行遵守好游快爆的用户协议与社区规则，自动发帖产生的一切后果由使用者自己承担。

在好游快爆放一个 AI 小号。两条独立的腿：

1. **被动回帖** —— 有人 `@小号`，小号读到后用 AI 生成回复发回楼中楼。两种收法：读平台消息中心的「@我的」
  通知（**不用配任何 id**，别人在哪 @ 都收得到），或者自己盯几个板块 / 帖子。
2. **主动刷帖** —— 宿主自己的时钟到点扫板块、给帖子打分排序、深读前几帖、写一份中文日报落盘，
   再把「你醒了」的任务书塞进她自己的会话（`sessionController.prompt`），让她读到日报、挑话、推给主人。

第 2 条是「真的会自己刷论坛」与「只能等人 @」的分界：日报是材料，叫醒会话才是让她真的过日子。

形态与 `dsh-bili-whale` 一致：一个 DSH 插件（设置页 + 宿主定时器）+ 一套共用工具链。

**配置项到底怎么配、哪些不配就完全用不了、留空是「不扫」还是「扫全部」—— 看 [CONFIG.md](./CONFIG.md)。**

## 装

本机没装 `dsh` CLI 时手工装（等价于 `dsh plugin --profile desktop add link:<path>`）：

```powershell
# 1. 源码挂进插件库
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\plugins\dsh-hykb-whale" ``
  -Target "<仓库路径>\dsh-hykb-whale"
# 2. 挂进 profile 的 node_modules
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-hykb-whale" ``
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-hykb-whale"
# 3. profile/package.json 里加依赖与 bundle（见下）
```

`~\.dsh\profiles\desktop\package.json`：

```json
{
  "dependencies": { "dsh-hykb-whale": "link:C:/Users/<你>/.dsh/plugins/dsh-hykb-whale" },
  "dsh": { "profile": { "bundles": [ "...", "dsh-hykb-whale" ] } }
}
```

装完在 DSH 里按刷新按钮，或重启 DSH。设置页在 **设置 → 快爆**。

## 用

```bash
node tools/hykb.mjs login            # 扫码登录，cookie 落到 ~/.hykb-ai/credentials.json
node tools/hykb.mjs whoami           # uid / 昵称 / 未读数
node tools/hykb.mjs read <帖子id>     # 读帖子
node tools/hykb.mjs summary <帖子id>  # AI 总结
node tools/hykb.mjs reply <帖子id> "内容"   # 发主回复
node tools/hykb.mjs comment <帖子id> <楼层id> "内容"  # 发楼中楼
node tools/hykb.mjs del <帖子id> <楼层id>   # 删自己楼层
node tools/hykb.mjs traffic          # 本小时/今天 读写作数与冷却
node tools/hykb.mjs listen           # 常驻监听（与设置页里的开关同一份配置）
node tools/hykb.mjs browse --dry     # 只读：这一轮会扫哪些板块、前 N 名是谁
node tools/hykb.mjs browse sections  # 本轮会扫的板块清单
node tools/hykb.mjs digest --dry     # 跑一轮日报但不回帖、不叫醒
node tools/hykb.mjs digest           # 真跑：写日报 +（可选）对高分帖回帖
```

日报落在 `~/.dsh/hykb-work/digest-<YYYY-MM-DD>.md`，同一天多轮是追加，不覆盖。

## 刷帖怎么配

设置页 **设置 → 快爆 → 刷帖**：

| 字段 | 作用 | 默认 |
| --- | --- | --- |
| 总开关 | 开了才按时钟刷 | 关 |
| 刷帖间隔（秒） | 两轮之间的最短间隔 | 3600 |
| 全天刷 / 时间段 | 关掉全天就只在窗口内刷 | 全天 |
| 扫哪些板块 | 板块 id 逗号分隔；留空 = 公共讨论区六件套 | 空 |
| 日报写几帖 | `pick` | 8 |
| 深读几帖 | 前 N 帖拉楼层压成速读，再合成日报 | 3 |
| 对高分帖自动回帖 | 写操作，仍受 risk 预算与写冷却 | 关 |
| 回帖分数线 / 每轮最多回几条 | `replyMinScore` / `replyMax` | 40 / 3 |
| 刷完叫醒会话 | 关掉 = 只写日报文件，不在她会话里说话 | 开 |

**要让她真的"刷"起来，必须给那个会话完全访问权限** —— 她醒来要跑命令行读日报、看帖子。
会话在 **工作区 → 未分组** 里，不点开看不见。没有 `sessionController`（headless 模式）时日报照写，
但不会叫醒任何人；设置页「刷新状态」会直接写出这一条。

## 刷帖打分

`score = 回复×3 + 楼中楼×1 + 赞×2 + 浏览×0.01 + 精华 8 + 置顶 2 + 新鲜度 6×0.5^(小时/24)`，
权重在 `browse.score` 里，设置页没暴露，改配置文件即可。

## 设置页长什么样

打开 **设置 → 快爆**，从上到下六张卡：

| # | 卡片 | 一张卡做完什么 |
| --- | --- | --- |
| 1 | 登录账号 | 没登录时卡头下方整块放二维码（112px 图 + 右侧状态与按钮），扫完自动变「已登录：昵称（uid）」 |
| 2 | 接上 AI | 接口地址 / 模型 / 密钥，她写的话由这个模型生成 |
| 3 | 她是谁 | 角色名、她怎么称呼你、说话风格、人设补充，三行决定回帖口吻 |
| 4 | 自动回帖 | 扫描间隔、**怎么算 @ 我**（两种都认 / 只认真 @ / 只认文字 @）、四个源页签（**@ 我通知**（默认开、无需任何 id）/ 板块 / 帖子 / @ 的规矩）各自的开关与清单、「每轮最多读几帖 / 最多回几条」—— 关掉时整张卡正文不渲染，只剩一句「关着：不会主动发任何回复。」卡底一颗按钮按宿主状态二选一：没跑显示「启动」，在跑显示「停止」 |
| 5 | 自动刷论坛 | 多久刷一轮、日报写几帖、深读几帖、刷完叫醒她、顺手回高分帖 |
| 6 | 安全阀 | 两次写之间隔、每小时/每天上限，所有出网共用这一份额度账本 |

卡片 4、5 顶上各有一排**模式卡**（只回 @ / 两个都要 / 只刷不发 / 先关着），点一下就同时改 `listen.enabled` 与 `browse.enabled`，不用分别进两张卡找开关。当前态由这两个布尔反推，选中项只靠边框与标题变色表示。

版式照 `dsh-bili-whale` 的设置页来：没有卡片阴影、没有彩色图标块。每行左边标签 + 灰字提示，右边控件。**卡片之间靠圆角深灰背景块分开**（`.hkw-card`：`border-radius:12px` + `background:var(--dsw-alias-interactive-bg-active)`，容器 `gap:10px`），**不用分割线**；卡片标题行是「序号圆点 + 标题 + 右侧开关」。输入框是透明底 + 1px 细边（不是填色块），开关 36x20，按钮 30px 高。

页面顶部状态条四枚 chip：`账号` `AI` `回帖` `刷帖`；宿主没有会话能力时多一枚红 chip `叫醒 / 宿主无会话能力`。

**没有保存按钮**：改哪个就存哪个，改动去抖 400ms 后整份配置自动提交，页尾只留一行状态——`改动会自动保存` / `保存中…` / `✓ 已保存` / `✗ 保存失败，改一下会重试`。提交的始终是整份配置，所以没显示的字段不会被抹掉；保存期间继续改，会等这次回来再补一次提交。命令行用法收在最下面的 `命令行用法` 折叠里。

版式约束（改样式时守住）：`.hkw` 宽 720px 封顶、行内右列 `minmax(120px,200px)`、所有控件右边缘同一条线、无横向溢出；字号只有六档、行高全部写死（`[line-height]` 里不许出现 `normal`）；`.hkw` 上必须有 `container-type:inline-size`，窄于 520px 时靠 **`@container`** 而不是 `@media` 降级成单列（`.hkw-grid4` 四列降两列）——DSH 设置面板是容器，视口宽度不等于面板宽度（漏了 `container-type` 这行，窄屏不会降级、右列会横向溢出）。

改完的视觉自检：跑 `node --test "tests/ui.test.mjs"` 确认结构没坏（卡片序号连续、字段路径都存在于默认配置、正文里没有 `undefined` / `NaN`、没有保存按钮、点一下开关会自动 POST 一次），再在设置页里缩到 340px 宽看一眼单列降级。上面那组像素值来自一次真实无头浏览器测量，不是渲染时校验的。

写 CSS 时注意：属性选择器的值不能裸写数字，`[data-on=1]` 是非法选择器，整条规则会被浏览器丢掉（开关就一直灰着、滑块不动），必须写成 `[data-on='1']`。

## 测试

```bash
npm test                                  # 等价于下面这条
node --test "tests/*.test.mjs"
```

全部用例都是离线的：出网一律走 `fetch` 桩，不碰真实平台。注意 `node --test tests/`（传目录）会 MODULE_NOT_FOUND，要传 glob 并加引号让 node 自己展开。

覆盖：路由 / 设置页归一化 / 刷帖 / 时钟 / 监听去重 / 读预算 / seen.json 并发 / dry-run 不落盘 / 触发器。

`tests/trigger.test.mjs` 在 Node 26 下会挂住不返回，单独跑它自己。

## 协议

MIT，见 [LICENSE](./LICENSE)。
