# 强制设置输入和输出编码为 UTF-8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 确保 PowerShell 会话本身能正确解析中文字符
$OutputEncoding = [System.Text.Encoding]::UTF8

# 1. 设置下载路径
$installerPath = "$env:TEMP\OllamaSetup.exe"
$downloadUrl = "https://ollama.com/download/OllamaSetup.exe"

# 2. 下载安装包
Write-Host "正在下载 Ollama 安装程序..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $downloadUrl -OutFile $installerPath

# 3. 执行静默安装
Write-Host "正在安装，请稍候..." -ForegroundColor Yellow
Start-Process -FilePath $installerPath -ArgumentList "/S" -Wait

# 4. 环境清理
Remove-Item $installerPath

# 5. 验证安装
Write-Host "安装完成！正在启动并下载模型..." -ForegroundColor Green
$env:Path += ";$env:LOCALAPPDATA\Ollama"
# 自动拉取代码模型
ollama run qwen2.5-coder:7b