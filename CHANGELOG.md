# Changelog

All notable changes to the **Dream C++ Debugger (GDB)** extension will be documented in this file.

## [1.1.2] - 2026-11-09

### Fixed & Enhanced
- **修复修改 `std::string` 变量（如 `title`）时 GDB 报错 `Invalid cast.` 的问题，并支持直接修改 `std::vector` 与数组元素**：
  - **原因**：在 GDB 中直接执行 `title = "xxx"` 时，GDB 表达式求值器无法自动将字符串字面量隐式重载转换为 `std::string`，从而抛出 `Invalid cast.`。
  - **修复**：在 `setVariableValue` 中自动识别 `std::string` 类型（兼容带引号 `"abc"` 或不带引号 `abc` 输入），通过调用 `title.assign("...", byteLen)`（以及底层 `_M_dataplus._M_p` 内存写入兜底）完成字符串热修改；同时支持直接点击右侧调试台中的数组/`vector` 单元格 `[i]` 或整体修改 `std::vector` 与 C 数组的值。

## [1.1.1] - 2026-11-09

### Fixed
- **修复局部变量尚未执行到声明行时，`std::vector` / `std::string` 读取未初始化栈内存报错的问题**：
  - **原因**：当断点停在函数前部（例如 `main()` 第 17 行入口）时，后续行（如第 24 行 `vector<int> fib`）虽已在 DWARF 栈帧符号表中，但其构造函数尚未执行，栈内存中 `_M_start` / `_M_finish` 为随机脏数据，导致 GDB Python Pretty-Printer 输出 `std::vector of length 3850240, capacity 3855324 = {<error reading variable: Cannot access memory at address 0x0>}`。
  - **修复**：新增 **源码声明行号感知 (`_findLocalDeclarationLines`)** 与 **STL 容器未初始化内存校验 (`isUninitializedOrCorruptGdbValue` / `extractStdVectorPointers`)** 双重保护。对于当前执行行尚未到达声明处的局部变量，清晰显示为 `⏳ 尚未初始化 (第 X 行声明)`，待单步执行越过声明行后再自动解包展示真实元素格子。

## [1.1.0] - 2026-11-09

### Changed & Added
- **重构为“左侧边栏输入编译 + 右半窗格独立调试大屏”双栏布局**：
  - **左侧活动栏侧边栏 (`src/sidebarHtml.js`)**：精简为专注负责 **`▶ 编译并开始 GDB 调试`**、**`⚡ 编译运行`**、**`📥 标准输入 (stdin)`** 与 **`📤 程序输出 (stdout / stderr)`**，为多行输入样例和程序输出留出充裕空间。
  - **右侧独立调试工作台页面 (`src/dashboardHtml.js`)**：启动 GDB 调试时自动在当前编辑器窗格的右半边（`vscode.ViewColumn.Beside`）展开宽敞的 **GDB 调试台** 页面，放置单步控制栏、局部变量 & STL/数组可视化格子、监视表达式、调用栈、条件断点管理、CPU 寄存器与 GDB 命令台，告别侧边栏宽度拥挤问题。

## [1.0.2] - 2026-11-09

### Fixed
- **修复第二次及后续 GDB 调试提示“启动 GDB 失败”的竞态问题**：
  - **原因 1（进程关闭事件竞态）**：旧版 `stop()` 发送 `-gdb-exit` 后未等待旧 GDB 进程完全退出便立即置空 `this.proc` 并启动新 GDB 进程；数毫秒后旧 GDB 进程退出触发 `close` 事件，误将新会话的 `this.pending` 命令队列全部以 `GDB 进程已退出` 拒绝，并删除了新会话的临时 `stdin.txt` / `stdout.txt`，同时 `stop()` 中残留的 `300ms` 定时器误杀了新启动的 `this.proc`。
  - **原因 2（可执行文件占用锁）**：第一次调试被调程序结束（`exited-normally`）后底层 `gdb` 进程未主动退出，且重新编译前未先终止旧 `gdb`，在 Windows 下会导致 `.exe` 被占用。
  - **修复方案**：为每次会话引入独立的 `sessionId`、闭包绑定的 `proc` 与独立临时目录；重构 `stop()` 异步等待旧进程彻底退出后再返回；在程序 `exited` 时自动退出底层 GDB 进程；编译前先 `await this.session.stop()`，并在可执行文件被系统锁定时自动回退到唯一文件名。

## [1.0.1] - 2026-11-09

### Fixed & Improved
- **大幅提升侧边栏对比度与可读性**：重构深色（`vscode-dark`）与浅色（`vscode-light`）双主题高对比度配色方案，强化卡片边框（`1.5px` 实线）、按钮字重、变量名/变量值/数组格子对比度，确保在各类 VS Code 主题下清晰醒目。
- **严格区分编译警告 (`Warning`) 与编译错误 (`CE`)**：
  - 修复侧边栏将编译器 `warning`（如 `unused variable 'dp' [-Wunused-variable]`）渲染为红色 `✖` 错误卡片的问题。
  - 编译器 `warning` 现使用琥珀黄警告样式（`⚠ [警告] ... · 不影响调试`）并支持一键关闭，绝不阻塞 GDB 调试会话启动；仅当存在真正的编译错误（`exitCode != 0`）时才显示红色 `✖ 编译错误 (CE)`。
  - 默认编译参数移除强制 `-Wall`（改为 `["-g", "-O0", "-std=c++17"]`），避免调试时临时定义的观察变量触发多余的未使用变量警告，同时新增中文 GCC 输出（`错误:` / `警告:`）解析支持。

## [1.0.0] - 2026-11-09

### Added
- **零配置一键 GDB 调试**：无需手动编写繁琐的 `launch.json` 与 `tasks.json`，打开 `.cpp` / `.c` 文件即可一键使用 `g++ -g -O0` 编译并启动 `gdb --interpreter=mi2` 调试会话。
- **现代简洁侧边栏工作台 (`Dream C++ Debugger`)**：
  - 实时状态指示灯、单步执行控制栏（继续 `F5`、跳过 `F10`、进入 `F11`、跳出 `Shift+F11`、重启、停止 `Shift+F5`）。
  - **局部变量与 STL/数组可视化**：自动展开 `std::vector`、`std::string` 与一维数组，渲染直观的 `[index] -> value` 数组格子条带，支持变量变化高亮与行内直接修改变量值。
  - **监视表达式 (`Watch`)**：支持任意 C++ 表达式与 GDB 数组切片语法（如 `arr@8`、`dp[i][j]`）。
  - **程序输入/输出面板 (`stdin & stdout`)**：在侧边栏直接粘贴多行测试数据自动注入 `cin` / `scanf`，实时捕获 `stdout` / `stderr` 输出。
  - **调用栈 (`Call Stack`) 与条件断点管理**：一键切换栈帧、跳转源码行、设置断点触发条件与查看命中次数。
  - **交互式 GDB 命令台与 CPU 寄存器监控**。
- **编辑器深度集成**：当前断点暂停行高亮、代码行尾实时内联变量预览 (`// x = 42 │ sum = 105`)、鼠标悬停表达式求值 (`Hover`)、`main()` 函数上方快捷 `CodeLens` 以及原生 VS Code Debug Adapter (`type: "dream-cpp-gdb"`) 双向同步。
