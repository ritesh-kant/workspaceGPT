"""
The work-brief overlay's icons (bridge/cue-*.svg), drawn from the app icon
(src-tauri/icons/128x128.png): one shared drawing, three states.

  python3 scripts/cue-icons.py bridge

ready      the app icon
thinking   a pulse runs around the brain, the bulb glows (building / answering)
listening  the bulb lines become a bouncing voice meter (for a future listening mode)
Animations stop under prefers-reduced-motion.
"""
import sys, os
out = sys.argv[1]
BLUE, GREEN, WHITE = '#1E69B8', '#21F0B3', '#F7F8F9'
# Left half of the brain (the right half is its mirror image about x=64).
HEMI = ('M62 30 C60 26 54 25 51 29 C45 27 40 31 40 37 C34 38 31 44 33 49 C29 53 29 60 33 63 '
        'C31 68 34 74 39 75 C40 81 47 84 52 81 C55 85 60 85 62 82 Z')
FOLDS = 'M51 47 C46 49 45 55 49 58 M43 64 C47 64 49 67 48 71 M52 76 C55 75 56 71 54 68'
MIRROR = 'translate(128 0) scale(-1 1)'

# Narrower and a little lower than the drawing above, to match the PNG.
FIT = 'matrix(0.86 0 0 0.947 8.96 4.37)'

def brain(stroke=GREEN, extra=''):
    return (f'<g transform="{FIT}" fill="none" stroke="{stroke}" stroke-width="4.7" stroke-linecap="round" stroke-linejoin="round"{extra}>'
            f'<path d="{HEMI}"/><path d="{FOLDS}"/>'
            f'<g transform="{MIRROR}"><path d="{HEMI}"/><path d="{FOLDS}"/></g></g>')

BULB = (f'<g class="bulb" stroke="{GREEN}" stroke-width="5" stroke-linecap="round">'
        '<path d="M53.5 92 H71"/><path d="M57.5 99.5 H67"/></g>')
CHEVRONS = (f'<g fill="none" stroke="{WHITE}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">'
            '<path d="M30 44.5 L21 62 L30 79.5"/><path d="M98 44.5 L107 62 L98 79.5"/></g>')

def svg(title, body, style=''):
    css = f'<style>{style}@media (prefers-reduced-motion: reduce){{*{{animation:none!important}}}}</style>' if style else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="{title}">'
            f'<title>{title}</title>{css}<circle cx="64" cy="64" r="64" fill="{BLUE}"/>{body}</svg>\n')

# Ready: the brand icon as it is.
ready = svg('WorkspaceGPT: ready', CHEVRONS + brain() + BULB)

# Thinking: a bright pulse runs around each half of the brain; the bulb glows.
pulse = (f'<g transform="{FIT}" fill="none" stroke="#C9FFF0" stroke-width="5.1" stroke-linecap="round">'
         f'<path class="run" pathLength="100" d="{HEMI}"/>'
         f'<path class="run" pathLength="100" transform="{MIRROR}" d="{HEMI}"/></g>')
thinking = svg('WorkspaceGPT: thinking', CHEVRONS + brain() + pulse + BULB,
    '.run{stroke-dasharray:14 86;animation:run 1.4s linear infinite}'
    '@keyframes run{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}'
    '.bulb{animation:glow 1.4s ease-in-out infinite}'
    '@keyframes glow{50%{opacity:.35}}')

# Listening: the bulb's two lines become five bars that bounce, like a voice meter.
bars = ''.join(f'<path class="b b{i}" d="M{x} 92 V100"/>' for i, x in enumerate([52, 58, 64, 70, 76]))
listening = svg('WorkspaceGPT: listening', CHEVRONS + brain() + f'<g stroke="{GREEN}" stroke-width="4.6" stroke-linecap="round">{bars}</g>',
    '.b{transform-box:fill-box;transform-origin:center;animation:eq .9s ease-in-out infinite}'
    '.b0{animation-delay:-.45s}.b1{animation-delay:-.15s}.b2{animation-delay:-.6s}.b3{animation-delay:-.3s}.b4{animation-delay:-.75s}'
    '@keyframes eq{0%,100%{transform:scaleY(.35)}50%{transform:scaleY(1.45)}}')

for name, text in [('cue-ready.svg', ready), ('cue-thinking.svg', thinking), ('cue-listening.svg', listening)]:
    open(os.path.join(out, name), 'w').write(text)
    print(name, len(text), 'bytes')
