# Converts a Word / Excel / PowerPoint file to PDF using the Microsoft Office installed on this PC.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File convert_to_pdf.ps1 <input file> <output.pdf>
# Exit code 0 = PDF written; otherwise the error is printed.
param([Parameter(Mandatory)][string]$InputFile, [Parameter(Mandatory)][string]$OutputPdf)
$ErrorActionPreference = 'Stop'
$ext = [IO.Path]::GetExtension($InputFile).ToLower()
$app = $null; $doc = $null

# Office answers "call was rejected" (0x80010001) while it is still starting or busy: retry for up to 30 s
function Retry([scriptblock]$Action) {
  for ($i = 0; $i -lt 30; $i++) {
    try { return & $Action }
    catch {
      if ($_.Exception.HResult -ne -2147418111 -and $_.Exception.Message -notmatch '0x80010001|rejected by callee') { throw }
      Start-Sleep -Seconds 1
    }
  }
  throw 'Office stayed busy for 30 seconds (it may be showing a message, e.g. about activation)'
}
try {
  switch -Regex ($ext) {
    '^\.(doc|docx|docm|rtf|odt|txt)$' {
      $app = New-Object -ComObject Word.Application
      $app.Visible = $false; $app.DisplayAlerts = 0
      # Open(FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument) - a wrong
      # password makes Word fail instead of waiting for someone to type it
      $doc = $app.Documents.Open($InputFile, $false, $true, $false, 'x-no-password')
      $doc.ExportAsFixedFormat($OutputPdf, 17)   # 17 = PDF
      $doc.Close(0)
    }
    '^\.(xls|xlsx|xlsm|csv|ods)$' {
      $app = New-Object -ComObject Excel.Application
      Retry { $app.Visible = $false; $app.DisplayAlerts = $false; $app.AskToUpdateLinks = $false }
      # Open(FileName, UpdateLinks, ReadOnly, Format, Password)
      $doc = Retry { $app.Workbooks.Open($InputFile, 0, $true, 5, 'x-no-password') }
      Retry { $doc.ExportAsFixedFormat(0, $OutputPdf) }   # 0 = PDF, all sheets with their print setup
      Retry { $doc.Close($false) }
    }
    '^\.(ppt|pptx|odp)$' {
      $app = New-Object -ComObject PowerPoint.Application
      # Open(FileName, ReadOnly, Untitled, WithWindow)
      $doc = $app.Presentations.Open($InputFile, -1, 0, 0)
      $doc.SaveAs($OutputPdf, 32)                # 32 = PDF
      $doc.Close()
    }
    default { throw "Unsupported file type $ext" }
  }
  if (-not (Test-Path $OutputPdf)) { throw 'Office did not create the PDF' }
  exit 0
} catch {
  Write-Output "ERROR: $($_.Exception.Message)"
  exit 1
} finally {
  if ($app) { try { $app.Quit() } catch {} ; [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) }
}
