# Remote Print

Office printing from WhatsApp groups and a private web page, on a Windows PC with a Brother DCP-T830DW.

## WhatsApp printing (`whatsapp/`)
- Members send a PDF or Word file in their department's print group (`PRINT_GROUPS` in `bot.js`).
- The bot asks: 1 Direct Print, 2 Choose options (copies, colour, sides, pages, tray, orientation), 3 Letterhead (MP Tray).
- Prints with SumatraPDF (A4), watches the Windows print queue and reports ✅ Printed or ⚠️ Not printed yet.
- Word files are converted to PDF with Microsoft Word (`convert_to_pdf.ps1`).
- Starts hidden with Windows (`start_hidden.vbs`); first run / re-link: `start_whatsapp_print.bat`, then scan the QR code (`qr.html`).
- Tests: `node test_print_flow.js`

## Print web page
- `print_server.py`: upload a PDF/JPG/PNG with the PIN (`pin.txt`, created on first run), Direct Print or options.
- `tunnel.py`: public link through a Cloudflare quick tunnel (link written to `Print link.txt` on the Desktop).
- Tests (dry run, nothing printed): `python test_print_server.py`

## Setup on a new PC
1. Install Node.js LTS and Python 3; `cd whatsapp && npm install` (set `PUPPETEER_SKIP_DOWNLOAD=true`, Chrome is used).
2. Put `SumatraPDF.exe` (portable, sumatrapdfreader.org) and, for the public link, `cloudflared.exe` in this folder.
3. Set the printer name in `whatsapp/bot.js` and `print_server.py`.

Private files (WhatsApp session, PIN, documents, logs) are excluded by `.gitignore` and must never be committed.
