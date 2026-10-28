---
name: docx
description: Read, edit, and convert Word .docx files with the tools this session already has, naming the missing converter when a conversion cannot run
---

# Word (.docx)

A .docx is a ZIP of XML parts. `unzip`, `zip`, and `python3` are enough to read and edit it, so do not install a Python or npm package for this task.

## Read the text

Copy the archive to a scratch directory and read the main part:

```sh
scratch=$(mktemp -d)
unzip -q report.docx -d "$scratch"
python3 - "$scratch/word/document.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
root = ET.parse(sys.argv[1]).getroot()
for paragraph in root.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}p'):
    text = ''.join(node.text or '' for node in paragraph.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))
    if text.strip():
        print(text)
PY
```

`word/document.xml` holds the body; `word/header*.xml`, `word/footer*.xml`, and `word/footnotes.xml` hold the rest. Read them the same way when the question mentions a header, a footer, or a note.

## Edit the text

Unzip, change only the text runs you mean to change, and zip the same layout back:

```sh
scratch=$(mktemp -d)
unzip -q report.docx -d "$scratch"
python3 - "$scratch/word/document.xml" "old sentence" "new sentence" <<'PY'
import sys
import xml.etree.ElementTree as ET

path, old, new = sys.argv[1:4]
tree = ET.parse(path)
changed = 0
for node in tree.getroot().iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'):
    if node.text and old in node.text:
        node.text = node.text.replace(old, new)
        changed += 1
if changed == 0:
    raise SystemExit('the text was not found in one run; read the document first')
tree.write(path, encoding='utf-8', xml_declaration=True)
PY
(cd "$scratch" && zip -qr "$OLDPWD/report-edited.docx" .)
```

A phrase split across several runs will not match. Search the plain text from the read step, find the run that holds the fragment, and change that run. Keep the original file and write the result to a new name until the human accepts it.

## Convert

Conversion to PDF or another office format needs an external converter. Check before you promise one:

```sh
command -v soffice || command -v libreoffice || command -v pandoc || echo none
```

- LibreOffice present: `soffice --headless --convert-to pdf --outdir "$PWD" report.docx`
- Pandoc present: `pandoc report.docx -o report.pdf` (a PDF engine must also be installed)
- Neither present: stop and answer with the reason, for example `cannot produce report.pdf: this machine has neither LibreOffice (soffice) nor Pandoc on PATH, and a .docx cannot be rendered as PDF without one of them; the extracted text is above`. Do not write a PDF by hand and do not install a converter without the human's approval.
- Text only on macOS: `textutil -convert txt report.docx` needs no extra install.

## Stop rules

- Do not claim a page, style, or layout survived an edit you did not inspect in the XML.
- Do not upload the file to a converter service; keep it local.
- Delete the scratch directory when the task ends.
