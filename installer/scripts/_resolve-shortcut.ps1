$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut('C:\Users\Public\Desktop\Inno Setup Compiler.lnk')
Write-Host $lnk.TargetPath
