# Finite, offline geometry plots. No server, external map tiles, or database access.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$reviewRoot = Join-Path $PSScriptRoot '../../data/gpx/base-access-start-v2'
$review = Get-Content -LiteralPath (Join-Path $reviewRoot 'comparison.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$font = [System.Drawing.Font]::new('Segoe UI', 13)
$heading = [System.Drawing.Font]::new('Segoe UI', 20, [System.Drawing.FontStyle]::Bold)
$blue = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#2563eb'), 6)
$orange = [System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml('#ea580c'), 3)
try {
  foreach ($row in $review.rows) {
    $geo = Get-Content -LiteralPath (Join-Path $reviewRoot "$($row.mountainId)-comparison.geojson") -Raw -Encoding UTF8 | ConvertFrom-Json
    $points = @($geo.features | ForEach-Object { $_.geometry.coordinates | ForEach-Object { ,$_ } })
    $lon = @($points | ForEach-Object { [double]$_[0] }); $lat = @($points | ForEach-Object { [double]$_[1] })
    $minLon = ($lon | Measure-Object -Minimum).Minimum; $maxLon = ($lon | Measure-Object -Maximum).Maximum
    $minLat = ($lat | Measure-Object -Minimum).Minimum; $maxLat = ($lat | Measure-Object -Maximum).Maximum
    $cos = [Math]::Cos(($minLat + $maxLat) / 2 * [Math]::PI / 180)
    $widthM = [Math]::Max(1, ($maxLon - $minLon) * 111195 * $cos)
    $heightM = [Math]::Max(1, ($maxLat - $minLat) * 111195)
    $scale = [Math]::Min(960 / $widthM, 530 / $heightM)
    $offsetX = 70 + (960 - $widthM * $scale) / 2
    $offsetY = 145 + (530 - $heightM * $scale) / 2
    $bitmap = [System.Drawing.Bitmap]::new(1100, 780)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.DrawString("$($row.mountainId) | $($row.name)", $heading, [System.Drawing.Brushes]::Black, 30, 18)
      $graphics.DrawLine($blue, 32, 75, 67, 75)
      $graphics.DrawString("Old: $($row.old.name) | $([Math]::Round($row.old.distanceMeters / 1000, 2)) km", $font, [System.Drawing.Brushes]::Black, 78, 61)
      $graphics.DrawLine($orange, 32, 110, 67, 110)
      $newText = if ($null -ne $row.new) { "V2: $($row.new.kind) | $([Math]::Round($row.new.distanceMeters / 1000, 2)) km" } else { 'V2: no accepted primary route - needs review' }
      $graphics.DrawString($newText, $font, [System.Drawing.Brushes]::Black, 78, 96)
      for ($i = 0; $i -lt $geo.features.Count; $i++) {
        $coords = $geo.features[$i].geometry.coordinates
        $line = [System.Drawing.PointF[]]@($coords | ForEach-Object {
          [System.Drawing.PointF]::new([single]($offsetX + ([double]$_[0] - $minLon) * 111195 * $cos * $scale),
            [single]($offsetY + ($maxLat - [double]$_[1]) * 111195 * $scale))
        })
        $pen = if ($i -eq 0) { $blue } else { $orange }
        $graphics.DrawLines($pen, $line)
        $brush = [System.Drawing.SolidBrush]::new($pen.Color)
        try { $graphics.FillEllipse($brush, $line[0].X - 6, $line[0].Y - 6, 12, 12) } finally { $brush.Dispose() }
        $graphics.DrawString('Start', $font, [System.Drawing.Brushes]::Black, $line[0].X + 8, $line[0].Y)
        if ($i -eq $geo.features.Count - 1) {
          $last = $line[$line.Length - 1]
          $graphics.FillRectangle([System.Drawing.Brushes]::Black, $last.X - 4, $last.Y - 4, 8, 8)
          $graphics.DrawString('Route terminal', $font, [System.Drawing.Brushes]::Black, [single]([Math]::Min(930, $last.X + 8)), $last.Y - 20)
        }
      }
      $scaleMeters = [Math]::Max(100, [Math]::Floor(150 / $scale / 100) * 100)
      $graphics.DrawLine([System.Drawing.Pens]::Black, 40, 715, [single](40 + $scaleMeters * $scale), 715)
      $graphics.DrawString("$scaleMeters m | north up | equal ground scale | geometry only, no terrain basemap", $font, [System.Drawing.Brushes]::Black, 40, 727)
      $bitmap.Save((Join-Path $reviewRoot "$($row.mountainId)-comparison.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
  }
} finally { $font.Dispose(); $heading.Dispose(); $blue.Dispose(); $orange.Dispose() }
Write-Output "Rendered $($review.rows.Count) offline geometry comparisons."
