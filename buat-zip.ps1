# Jalankan dari folder induk laundry-akbar-fullstack
$staging = Join-Path $env:TEMP "laundry-staging"
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
if (Test-Path .\laundry-akbar-fullstack.zip) { Remove-Item .\laundry-akbar-fullstack.zip -Force }
robocopy .\laundry-akbar-fullstack "$staging\laundry-akbar-fullstack" /E /XD node_modules .git /XF .env *.log /NFL /NDL /NJH /NJS | Out-Null
Compress-Archive -Path "$staging\laundry-akbar-fullstack" -DestinationPath .\laundry-akbar-fullstack.zip -Force
Remove-Item $staging -Recurse -Force
Write-Host "Selesai: laundry-akbar-fullstack.zip" -ForegroundColor Green
