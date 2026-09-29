$ErrorActionPreference = "Stop"
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$card = Join-Path (Split-Path $root -Parent) "card"
$pmos = Join-Path (Split-Path $root -Parent) "product-material-generate"
$uploadRoot = Join-Path $card "server\_data\uploads"
New-Item -ItemType Directory -Force -Path $uploadRoot | Out-Null

function Start-DevWindow($title, $cwd, $cmd) {
  Start-Process powershell -ArgumentList @("-NoExit", "-Command", "Set-Location '$cwd'; $cmd") -WindowStyle Normal
  Write-Host "started $title"
}

Start-DevWindow "card-api" (Join-Path $card "server") "go run ./cmd/server"

Start-Sleep -Seconds 3
try {
  $resp = Invoke-RestMethod -Method POST -Uri "http://127.0.0.1:8080/api/v1/dev/login" -ContentType "application/json" -Body '{"code":"qm-dev"}'
  $token = if ($resp.data.token) { $resp.data.token } elseif ($resp.token) { $resp.token } else { $resp.data.data.token }
  if (-not $token) { throw "dev login returned no token" }
  $mcpEnv = @"
`$env:ZHIQU_API_BASE_URL='http://127.0.0.1:8080/api/v1'
`$env:ZHIQU_API_TOKEN='$token'
`$env:ZHIQU_UPLOAD_ROOTS='$uploadRoot'
`$env:PORT='8310'
node dist/index.js --http
"@
  Start-DevWindow "card-mcp" (Join-Path $card "agent-card-mcp") $mcpEnv
} catch {
  Write-Warning "card-mcp skipped (card API not ready?): $_"
}

$pmosCoreEnv = @"
`$env:GOMODCACHE='C:\Users\Administrator\go\pkg\mod'
`$env:GOCACHE='C:\Users\Administrator\AppData\Local\go-build'
`$env:HTTP_ADDR=':8082'
`$env:DATABASE_URL='postgres://pmos:pmos@localhost:5433/pmos?sslmode=disable'
`$env:HMAC_SECRET='dev-hmac-secret-change-me'
`$env:JWT_SECRET='dev-jwt-secret-change-me'
`$env:MASTER_KEY='dev-master-key-change-me'
`$env:LOCAL_BASE_URL='http://host.docker.internal:8082'
`$env:RUN_MIGRATIONS='true'
`$env:STORAGE_DRIVER='local'
`$env:LOCAL_STORAGE_DIR='./data'
go run ./cmd/api
"@
Start-DevWindow "pmos-core" (Join-Path $pmos "core") $pmosCoreEnv

Start-DevWindow "pmos-mcp" (Join-Path $pmos "mcp-gateway") "npm run start"

$appsBackendEnv = @"
`$env:PORT='8300'
`$env:PARTNER_GATEWAY_URL='http://localhost:8209'
`$env:PARTNER_ID='zhiqu'
`$env:PARTNER_SECRET='dev-instance-partner-0123456789abcdef'
npm run dev
"@
Start-DevWindow "apps-backend" (Join-Path $root "apps\backend") $appsBackendEnv

Start-DevWindow "apps-frontend" (Join-Path $root "apps\frontend") "npm run dev"

Write-Host ""
Write-Host "URLs:"
Write-Host "  apps UI     http://localhost:5173"
Write-Host "  apps API    http://localhost:8300  (needs QM partner :8209)"
Write-Host "  card API    http://localhost:8080"
Write-Host "  card MCP    http://127.0.0.1:8310/mcp"
Write-Host "  pmos core   http://localhost:8082"
Write-Host "  pmos MCP    http://localhost:3000"
