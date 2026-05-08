Add-Type -AssemblyName System.Drawing
$path = Resolve-Path (Join-Path $PSScriptRoot '..\favicon.png')
# Read fully into memory so file isn't locked by GDI+ during Save.
$bytesIn = [System.IO.File]::ReadAllBytes($path)
$ms = New-Object System.IO.MemoryStream(,$bytesIn)
$src = [System.Drawing.Bitmap]::FromStream($ms)
$w = $src.Width; $h = $src.Height
$minX = $w; $minY = $h; $maxX = 0; $maxY = 0
$bmpData = $src.LockBits(
  (New-Object System.Drawing.Rectangle 0,0,$w,$h),
  [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
  [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $bmpData.Stride
$bytes = [byte[]]::new($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy([IntPtr]$bmpData.Scan0, $bytes, [int]0, [int]$bytes.Length)
$src.UnlockBits($bmpData)
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    # BGRA format; alpha is at offset 3
    $a = $bytes[$y * $stride + $x * 4 + 3]
    if ($a -gt 8) {
      if ($x -lt $minX) { $minX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
Write-Host "BBox: $minX,$minY -> $maxX,$maxY (src $w x $h)"
$cw = $maxX - $minX + 1
$ch = $maxY - $minY + 1
$side = [Math]::Max($cw, $ch)
# Add 4% padding so the icon doesn't touch the edge of the tab
$padding = [int]($side * 0.04)
$side = $side + 2 * $padding
$ox = $minX - [int](($side - $cw) / 2)
$oy = $minY - [int](($side - $ch) / 2)

$out = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($out)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$srcRect = New-Object System.Drawing.Rectangle $ox, $oy, $side, $side
$dstRect = New-Object System.Drawing.Rectangle 0, 0, 256, 256
$g.DrawImage($src, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()
$out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()
$src.Dispose()
Write-Host "Saved cropped 256x256 favicon."
