---
name: pptx
description: Read, outline, edit, and convert PowerPoint .pptx decks with the tools this session already has, naming the missing converter when a conversion cannot run
---

# PowerPoint (.pptx)

A .pptx is a ZIP of XML parts. `unzip`, `zip`, and `python3` read and edit it, so no package installation is needed.

## Outline the deck

Each slide is `ppt/slides/slideN.xml`; its text usually lives in `a:t` elements. List the slides in order with their text:

```sh
scratch=$(mktemp -d)
unzip -q deck.pptx -d "$scratch"
python3 - "$scratch" <<'PY'
import glob
import os
import sys
import xml.etree.ElementTree as ET

root = sys.argv[1]
slides = sorted(
    glob.glob(os.path.join(root, 'ppt', 'slides', 'slide*.xml')),
    key=lambda path: int(''.join(filter(str.isdigit, os.path.basename(path))) or 0),
)
for number, path in enumerate(slides, start=1):
    text = [node.text or '' for node in ET.parse(path).getroot().iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t')]
    print(f'--- slide {number}: {os.path.basename(path)}')
    print(' '.join(part for part in text if part.strip()))
PY
```

Speaker notes are `ppt/notesSlides/notesSlideN.xml` and map to a slide through `ppt/slides/_rels/slideN.xml.rels`. Read the relationship when the notes matter.

## Edit a slide

Replace one text run, then rewrite the archive. Do not rebuild the deck from scratch: charts, images, and theme references are easy to lose.

```sh
scratch=$(mktemp -d)
unzip -q deck.pptx -d "$scratch"
python3 - "$scratch/ppt/slides/slide1.xml" "Q3 review" "Q4 review" <<'PY'
import sys
import xml.etree.ElementTree as ET

path, old, new = sys.argv[1:4]
tree = ET.parse(path)
hits = 0
for node in tree.getroot().iter('{http://schemas.openxmlformats.org/drawingml/2006/main}t'):
    if node.text and old in node.text:
        node.text = node.text.replace(old, new)
        hits += 1
if hits == 0:
    raise SystemExit('no run matched; print the outline and pick the exact run')
tree.write(path, encoding='utf-8', xml_declaration=True)
PY
(cd "$scratch" && zip -qr "$OLDPWD/deck-edited.pptx" .)
```

## Convert

Rendering slides needs LibreOffice or a cloud service; prefer the local one. Check first:

```sh
command -v soffice || command -v libreoffice || echo none
```

- Present: `soffice --headless --convert-to pdf --outdir "$PWD" deck.pptx`
- Absent: stop and answer with the reason, for example `cannot produce deck.pdf: LibreOffice (soffice) is not on PATH, and a .pptx cannot be rendered as PDF without it; the outline is above`. Do not claim a slide count or layout looks right without rendering it.

## Stop rules

- A deck's slide order is the presentation order in `ppt/presentation.xml`, not the file name; check `sldIdLst` before you number slides.
- Preserve every part you did not change, including `[Content_Types].xml`.
- Delete the scratch directory when the task ends.
