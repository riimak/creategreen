import base64, io, sys
from PIL import Image

BRAND = "/mnt/c/Users/ivan/Workspace/repos/bios-creategreen/brand/"
HTML = "/mnt/c/Users/ivan/Workspace/repos/bios-creategreen/bios-multilevel-platform-services/dashboard/eu-visibility.html"

trim = Image.open(BRAND + "creategreen-eu-banner-trimmed.png").convert("RGB")
for colors in (64, 96, 128, 192, 256):
    q = trim.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    buf = io.BytesIO(); q.save(buf, "PNG", optimize=True)
    print(colors, "colors ->", len(buf.getvalue()), "bytes")

# pick 128 colors as the quality/size balance
q = trim.quantize(colors=128, method=Image.MEDIANCUT, dither=Image.NONE)
q.save(BRAND + "creategreen-eu-banner-trimmed.png", optimize=True)
buf = io.BytesIO(); q.save(buf, "PNG", optimize=True)
b64 = base64.b64encode(buf.getvalue()).decode()
print("chosen b64 len", len(b64))

with open(HTML, "r", encoding="utf-8") as f:
    html = f.read()
start = html.find('<figure class="eu-banner">')
end = html.find("</figure>", start)
if start == -1 or end == -1:
    print("ABORT: eu-banner figure not found"); sys.exit(1)
end += len("</figure>")
new = (
    '<figure class="eu-banner">'
    '<img alt="CREATEGREEN — Interreg IPA Hrvatska–Srbija, sufinancira Europska unija" '
    f'src="data:image/png;base64,{b64}">'
    '</figure>'
)
html = html[:start] + new + html[end:]
with open(HTML, "w", encoding="utf-8") as f:
    f.write(html)
print("replaced")
