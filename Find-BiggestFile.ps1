# Find-BiggestFile.ps1
# Finds the largest file in a given folder (recursively by default).
#
# Usage:
#   .\Find-BiggestFile.ps1                 # current directory, recursive
#   .\Find-BiggestFile.ps1 -Path C:\Data   # specific folder, recursive
#   .\Find-BiggestFile.ps1 -Path C:\Data -NoRecurse   # top level only

param(
    [Parameter(Position = 0)]
    [string]$Path = (Get-Location).Path,

    [switch]$NoRecurse
)

$recurse = if ($NoRecurse) { $false } else { $true }

$biggestFile = Get-ChildItem -Path $Path -File -Recurse:$recurse -ErrorAction SilentlyContinue |
    Sort-Object Length -Descending |
    Select-Object -First 1

if ($null -ne $biggestFile) {
    Write-Host "Largest file: $($biggestFile.FullName)"
    Write-Host ("Size:       {0:N2} MB ({1:N0} bytes)" -f ($biggestFile.Length / 1MB), $biggestFile.Length)
} else {
    Write-Host "No files found in '$Path'."
}
