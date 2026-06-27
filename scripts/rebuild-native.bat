@echo off
setlocal

rem Rebuild VS Code / MCode native modules against Electron headers.
rem Required when .node bindings or ripgrep are missing after npm install.

if /I not "%CL%"=="" (
	set "CL=%CL% /utf-8"
) else (
	set "CL=/utf-8"
)

set "npm_config_disturl=https://electronjs.org/headers"
set "npm_config_target=34.3.2"
set "npm_config_runtime=electron"
set "npm_config_build_from_source=true"

set "GYP=%~dp0..\build\npm\gyp\node_modules\.bin\node-gyp.cmd"
if not exist "%GYP%" (
	echo [rebuild-native] ERROR: node-gyp not found. Run npm install first.
	exit /b 1
)

set "ROOT=%~dp0.."
set FAILED=0

for %%P in (
	@vscode\spdlog
	@vscode\windows-mutex
	@vscode\windows-registry
	@vscode\windows-process-tree
	@vscode\policy-watcher
	@vscode\deviceid
	@vscode\sqlite3
	@vscode\windows-ca-certs
	native-keymap
	native-watchdog
	native-is-elevated
	node-pty
	kerberos
	windows-foreground-love
) do (
	echo.
	echo [rebuild-native] Rebuilding %%P ...
	pushd "%ROOT%\node_modules\%%P"
	call "%GYP%" rebuild --dist-url=https://electronjs.org/headers --target=34.3.2 --runtime=electron
	if errorlevel 1 set FAILED=1
	popd
)

echo.
echo [rebuild-native] Running ripgrep postinstall ...
pushd "%ROOT%\node_modules\@vscode\ripgrep"
node .\lib\postinstall.js
if errorlevel 1 set FAILED=1
popd

if %FAILED% NEQ 0 (
	echo [rebuild-native] One or more modules failed to rebuild.
	exit /b 1
)

echo [rebuild-native] Done.
exit /b 0
