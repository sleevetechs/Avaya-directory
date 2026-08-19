$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Test-DbPort($port) {
  node -e "const mysql=require('mysql2/promise');(async()=>{try{await mysql.createConnection({host:'127.0.0.1',port:$port,user:'root',password:''});process.exit(0);}catch{process.exit(1);}})();"
  return $LASTEXITCODE -eq 0
}

if (-not (Test-DbPort 3306)) {
  $mysqlBin = 'C:\xampp\mysql\bin\mysqld.exe'
  $mysqlCfg = 'C:\temp\avaya-mysql3307.cnf'
  if ((Test-Path $mysqlBin) -and (Test-Path $mysqlCfg) -and -not (Test-DbPort 3307)) {
    Write-Host 'MySQL 3306 unavailable — starting fallback MariaDB on 3307...'
    Start-Process -FilePath $mysqlBin -ArgumentList "--defaults-file=$mysqlCfg" -WindowStyle Hidden
    Start-Sleep -Seconds 4
    @"
PORT=3000
DB_HOST=127.0.0.1
DB_PORT=3307
DB_USER=root
DB_PASSWORD=
DB_NAME=avaya_list
JWT_SECRET=local-dev-secret
"@ | Set-Content -Path (Join-Path $root '.env') -Encoding utf8
  } elseif (-not (Test-DbPort 3307)) {
    Write-Host 'No local MySQL found. Start XAMPP/MySQL, then run this script again.'
    exit 1
  }
}

node scripts/init-local-db.js
Write-Host 'Starting app at http://localhost:3000'
node server.js
