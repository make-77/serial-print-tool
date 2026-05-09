# Serial Print Tool

> 基于 Web Serial API 的轻量串口日志查看、标记和自动保存工具。

![Static](https://img.shields.io/badge/runtime-browser-blue)
![Static](https://img.shields.io/badge/api-Web%20Serial-0f766e)
![Static](https://img.shields.io/badge/dependencies-none-brightgreen)

Serial Print Tool 是一个无需前端框架、无需构建步骤的本地串口日志工具。它直接使用 Chromium 浏览器的 Web Serial API 读取串口数据，支持 ASCII/HEX 显示、正则标记、控制字符可视化、自动保存和高吞吐日志渲染。

## Features

- 串口选择、波特率、数据位、校验位、停止位配置
- ASCII 和 HEX 两种显示模式
- 正则表达式标记输入，按实际接收文本匹配并高亮显示
- HEX 模式可用帧正则匹配协议帧，并按完整帧断行显示
- CR/LF 按真实换行处理，连续换行会保留为空行
- TAB/NUL/ESC 等其他非可见控制字符以红色 `<TAB>`、`<00>`、`<1B>` 等形式显示
- 可选时间戳显示
- INFO/WARN/ERROR/DEBUG/TRACE 日志级别高亮
- 自动底部跟随，手动上划后保持当前位置
- 手动滚动离开底部会暂停自动跟随，可点击“到底部”恢复
- 高吞吐数据按帧批量渲染，界面最多保留最近 20000 行以避免长时间运行卡死
- 自动保存到用户选择的目录，每次连接生成独立 `.log` 文件
- 终端只显示串口实际接收内容，不插入连接、断开等软件日志
- 20000 行界面日志上限，适合长时间串口输出查看

## Quick Start

```powershell
cd serial-print-tool
node server.mjs
```

然后使用 Chrome 或 Edge 打开终端输出的本地地址，通常是：

```text
http://127.0.0.1:4173
```

也可以在 Windows 上双击 `start.cmd` 启动本地服务。

## Requirements

- Chrome、Edge 或其他支持 Web Serial API 的 Chromium 内核浏览器
- Node.js 18 或更新版本
- 页面必须运行在 `localhost` 或安全上下文下

## Project Structure

```text
serial-print-tool/
├─ assets/
│  └─ icon.svg
├─ src/
│  └─ app.js
├─ index.html
├─ manifest.webmanifest
├─ server.mjs
├─ start.cmd
└─ styles.css
```

## Notes

- Web Serial API 需要浏览器用户手动授权串口，网页不能静默访问设备。
- 自动保存依赖 File System Access API，浏览器会要求用户选择保存目录。
- ASCII 模式下，正则标记按原始串口文本匹配；控制字符只在显示阶段转换成可见标记。
- HEX 断行正则按 `AA BB CC` 这样的 HEX 显示文本匹配，匹配到的每个完整片段会生成一条日志；首尾 `^` / `$` 会按整帧写法兼容处理。
