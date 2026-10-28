---
name: xlsx
description: Read, edit, and convert Excel .xlsx workbooks with the tools this session already has, naming the missing converter when a conversion cannot run
---

# Excel (.xlsx)

An .xlsx is a ZIP of XML parts. `unzip`, `zip`, and `python3` read and edit cells, so no package installation is needed.

## Read the workbook

Sheet names come from `xl/workbook.xml`; shared strings from `xl/sharedStrings.xml`; cell values from `xl/worksheets/sheetN.xml`. A formula cell also stores its last calculated value in `<v>`.

```sh
scratch=$(mktemp -d)
unzip -q book.xlsx -d "$scratch"
python3 - "$scratch" <<'PY'
import os
import re
import sys
import xml.etree.ElementTree as ET

root = sys.argv[1]
main = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
shared = []
path = os.path.join(root, 'xl', 'sharedStrings.xml')
if os.path.exists(path):
    shared = [''.join(t.text or '' for t in item.iter(main + 't')) for item in ET.parse(path).getroot().iter(main + 'si')]

import glob
for sheet_path in sorted(glob.glob(os.path.join(root, 'xl', 'worksheets', 'sheet*.xml')), key=lambda p: int(re.search(r'sheet(\d+)', p).group(1))):
    print('--- ' + os.path.basename(sheet_path))
    for row in ET.parse(sheet_path).getroot().iter(main + 'row'):
        cells = []
        for cell in row.iter(main + 'c'):
            ref = cell.get('r', '?')
            kind = cell.get('t')
            value = cell.find(main + 'v')
            inline = cell.find(main + 'is')
            text = ''
            if kind == 's' and value is not None:
                text = shared[int(value.text)]
            elif inline is not None:
                text = ''.join(t.text or '' for t in inline.iter(main + 't'))
            elif value is not None:
                text = value.text or ''
            if text != '':
                cells.append(f'{ref}={text}')
        if cells:
            print(' | '.join(cells))
PY
```

Dates arrive as serial numbers; `xl/styles.xml` holds the number format. Say "serial 45292" rather than inventing a date unless the format is a date format. Cached formula values can be stale; report that when it matters.

## Edit one cell

Change the stored value, then rewrite the workbook. Keep `[Content_Types].xml` and every part you did not touch.

```sh
scratch=$(mktemp -d)
unzip -q book.xlsx -d "$scratch"
python3 - "$scratch/xl/worksheets/sheet1.xml" B2 42 <<'PY'
import sys
import xml.etree.ElementTree as ET

path, ref, value = sys.argv[1:4]
tree = ET.parse(path)
main = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
for cell in tree.getroot().iter(main + 'c'):
    if cell.get('r') == ref:
        old = cell.find(main + 'v')
        if old is not None:
            old.text = value
        else:
            node = ET.SubElement(cell, main + 'v')
            node.text = value
        cell.attrib.pop('t', None)
        break
else:
    raise SystemExit(f'cell {ref} is not in this sheet; read the sheet first')
tree.write(path, encoding='utf-8', xml_declaration=True)
PY
(cd "$scratch" && zip -qr "$OLDPWD/book-edited.xlsx" .)
```

Shared formulas (`<f t="shared">`) and merged ranges have more state than one cell shows; inspect the surrounding XML before you change one.

## Convert

LibreOffice or another office suite performs the conversion:

```sh
command -v soffice || command -v libreoffice || echo none
```

- Present: `soffice --headless --convert-to csv --outdir "$PWD" book.xlsx` (one sheet, the active one)
- CSV only, LibreOffice absent: read the sheet with the script above and write the CSV yourself; this needs no converter.
- PDF or charts only, LibreOffice absent: stop and answer with the reason, for example `cannot produce book.pdf: LibreOffice (soffice) is not on PATH, and an .xlsx cannot be rendered as PDF without a spreadsheet engine; the cell values are above`.
- Do not install a converter without the human's approval.

## Stop rules

- Do not present a formula's cached value as a fresh calculation.
- Do not claim formatting, charts, or pivot tables survived an edit you did not inspect.
- Delete the scratch directory when the task ends.
