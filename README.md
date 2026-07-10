# R1 Web Serial Debugger

面向 R1 遥控器、底盘和定位板的浏览器串口观测工具。队友只需打开 HTTPS 网站，使用桌面版 Chrome 或 Edge 手动选择本机串口；不需要安装 Python 上位机。

## 功能

- 通信诊断：同时读取遥控器 RDBG 与底盘 CDBG，显示链路状态、解析错误、原始日志和 5 分钟趋势。
- 定位地图：读取 `$R1M`、CSV v2/v3 和 legacy CSV，绘制中心原点 1215×1210 cm 场地、Final/Calib/LiDAR 三轨迹、机器人朝向与 DT35 射线。
- 回放：打开 `.log`、`.txt`、`.csv` 或本站导出的 `.zip`，支持播放、暂停、单步和 0.25–5 倍速。
- 本地记录：采集分片写入浏览器 OPFS，异常刷新后可重新下载；停止时生成 Python 兼容文件名的 ZIP。

本站严格接收：代码不创建串口 writer、不发送命令，也不调用 `setSignals()`。USB 转串口驱动在打开端口时是否改变线路状态仍取决于具体硬件和驱动，首次使用必须观察板卡是否复位。

## 使用

1. 用 Windows Chrome/Edge 打开正式 `pages.dev` HTTPS 地址。
2. 在对应卡片点击“选择串口”，在浏览器弹窗中手动选择遥控器、底盘或定位板；端口号不会写死，网页也不会自动交换选错的设备。
3. 点击“连接”。`reading / valid` 表示正在收到有效协议帧；`bytes-only`、`stale`、`wrong-role` 会给出不同提示。
4. 需要完整记录时先点击“开始本地录制”，结束时点击“停止并下载”。下载路径由浏览器设置决定；此电脑若浏览器沿用系统下载目录，通常落在 `D:\网站下载`，网页本身不能强制指定目录。

Web Serial 必须运行在安全上下文中。Firefox、Safari、普通 HTTP 和直接双击 `file://` 不支持实时串口，但仍可在兼容环境使用文件回放。

## 本地开发与验证

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`localhost` 被浏览器视为安全上下文，可用于开发。开发服务器：

```powershell
npm run dev
```

## 数据与版本边界

- 串口数据只在当前浏览器内处理，不上传、不接遥测。
- OPFS 是站点私有临时/恢复存储；用户可见文件仅通过普通浏览器下载产生。
- UI 最多显示 1000 行日志、每类 5000 个轨迹点和最近 5 分钟趋势，完整录制不随显示降采样。
- Remote 行为冻结到 `cd0b796e392493c7c1acc46b5059f37c46bd0a66`。
- Locater 行为冻结到 `e6850444fdc3872951a64f8af035b1cffc099a94`；网页显示协议提供的原始 Final 结果，不引入冻结提交之后未提交的融合行为。

## 发布

站点为纯静态构建，不需要后端：

```powershell
npm run build
npx wrangler login
npx wrangler pages deploy dist --project-name r1-web-serial-debugger
```

Cloudflare OAuth 和浏览器串口授权必须由用户本人确认。仓库与 CI 不保存 Cloudflare/R2 密钥。
