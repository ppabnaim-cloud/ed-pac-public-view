# Drop new posters here

Staging only. Put the **original** image files in this folder — straight from
wherever you made them, nothing cropped, nothing renamed. They are picked up
from here, prepared, and moved into `web/rakyat/` proper.

## Uploading from a browser, no git needed

1. Open the repository on github.com.
2. Navigate to `web` → `rakyat` → `_incoming`.
3. **Add file → Upload files**, drag the images in, then **Commit changes**.

Any number at once. Filenames do not matter; they get sequential names when
they are prepared.

## What happens to them

Each image is:

- cropped along the bottom to remove the image generator's watermark,
- given a strip carrying **Reka bentuk: Dr Naim, HTPN**, burnt into the file
  so the credit survives being downloaded, forwarded or printed,
- saved into `web/rakyat/` and listed in `manifest.json` under the Peranan it
  belongs to,

and this folder is emptied again. Ministry material is credited to KKM
instead — say so when you upload it, since nothing in the file says which is
which.
