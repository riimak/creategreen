import base64, io, shutil, sys
from PIL import Image, ImageChops

SRC = "/mnt/c/Users/ivan/.cursor/projects/c-Users-ivan-Workspace-repos-bios-creategreen/assets/c__Users_ivan_AppData_Roaming_Cursor_User_workspaceStorage_7c926b9ffb6bad77835a1bb983c2fc99_images_CREATEGREEN_Sticker-0db68489-36cd-4cd9-9121-991fccc8483a.png"
BRAND = "/mnt/c/Users/ivan/Workspace/repos/bios-creategreen/brand/"
HTML = "/mnt/c/Users/ivan/Workspace/repos/bios-creategreen/bios-multilevel-platform-services/dashboard/eu-visibility.html"

# keep the full original as a brand asset
shutil.copyfile(SRC, BRAND + "creategreen-eu-banner.png")

# trim outer white margins for a tidy display
im = Image.open(SRC).convert("RGB")
bg = Image.new("RGB", im.size, (255, 255, 255))
diff = ImageChops.difference(im, bg)
bbox = diff.getbbox()
pad = 26
x0 = max(0, bbox[0] - pad); y0 = max(0, bbox[1] - pad)
x1 = min(im.width, bbox[2] + pad); y1 = min(im.height, bbox[3] + pad)
trim = im.crop((x0, y0, x1, y1))
trim.save(BRAND + "creategreen-eu-banner-trimmed.png", optimize=True)
print("trimmed size", trim.size)

buf = io.BytesIO()
trim.save(buf, "PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
print("png bytes", len(buf.getvalue()), "b64 len", len(b64))

with open(HTML, "r", encoding="utf-8") as f:
    html = f.read()

# 1) swap the CSS rule
old_css = ".cg-logo{height:38px;width:auto;display:block;margin:8px 0 20px}"
new_css = (
    ".eu-banner{display:block;margin:10px 0 30px;max-width:560px;width:100%}\n"
    ".eu-banner img{display:block;width:100%;height:auto;border:1px solid #e0e0e0;border-radius:8px;background:#fff}"
)
if old_css not in html:
    print("ABORT: cg-logo CSS rule not found"); sys.exit(1)
html = html.replace(old_css, new_css, 1)

# 2) swap the inline wordmark SVG for the banner image
start = html.find('<svg class="cg-logo"')
if start == -1:
    print("ABORT: cg-logo svg not found"); sys.exit(1)
end = html.find("</svg>", start)
if end == -1:
    print("ABORT: cg-logo svg end not found"); sys.exit(1)
end += len("</svg>")
img_block = (
    '<figure class="eu-banner">'
    f'<img alt="CREATEGREEN — Interreg IPA Hrvatska–Srbija, sufinancira Europska unija" '
    f'src="data:image/png;base64,{b64}">'
    '</figure>'
)
html = html[:start] + img_block + html[end:]

with open(HTML, "w", encoding="utf-8") as f:
    f.write(html)
print("done")
