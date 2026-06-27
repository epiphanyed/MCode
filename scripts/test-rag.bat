@echo off
setlocal

echo [test-rag] Running RAG unit tests...

pushd %~dp0\..

call node scripts\test-rag.js %*
set EXITCODE=%errorlevel%

popd

exit /b %EXITCODE%
