# Changelog

All notable changes to the **Dream C++ Debugger (GDB)** extension will be documented in this file.

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
