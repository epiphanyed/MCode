@echo off
setlocal

rem MSVC must compile UTF-8 sources as UTF-8 on Chinese Windows (code page 936).
rem Without this, native modules like usearch fail with C4819 / C2065 errors.
if /I not "%CL%"=="" (
	set "CL=%CL% /utf-8"
) else (
	set "CL=/utf-8"
)

echo [npm-install] CL=%CL%
echo [npm-install] Running npm install...

pushd %~dp0\..

call npm install %*
set EXITCODE=%errorlevel%

popd

exit /b %EXITCODE%
