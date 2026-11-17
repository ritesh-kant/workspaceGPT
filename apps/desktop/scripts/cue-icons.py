"""
The work-brief overlay's icons (bridge/cue-*.svg): an "ask me" speech bubble
on the app's blue, with the state drawn inside the bubble in the app's mint.
Simple enough to read at 36px, where the full app icon (brain, brackets and
bulb) blurred into one shape.

  python3 scripts/cue-icons.py bridge

ready      a small spark that breathes slowly
thinking   three dots that rise in turn, like "typing…" (building / answering)
listening  a bouncing voice meter (for a future listening mode)
Animations stop under prefers-reduced-motion.
"""
import sys, os
out = sys.argv[1]
BLUE, GREEN, WHITE = '#1E69B8', '#21F0B3', '#F7F8F9'

# A rounded square (the page clips it with the same 30% radius) and the bubble.
TILE = f'<rect x="1" y="1" width="38" height="38" rx="12" fill="{BLUE}"/>'
BUBBLE = (f'<path d="M12 11h16a3.5 3.5 0 0 1 3.5 3.5v8a3.5 3.5 0 0 1-3.5 3.5h-9l-5 4v-4h-2'
          f'a3.5 3.5 0 0 1-3.5-3.5v-8A3.5 3.5 0 0 1 12 11Z" fill="none" stroke="{WHITE}" stroke-width="2.2" stroke-linejoin="round"/>')
REDUCED = '@media (prefers-reduced-motion: reduce){*{animation:none!important}}'
ORIGIN = '{transform-box:fill-box;transform-origin:center}'

def svg(title, inside, style):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="128" height="128" role="img" aria-label="{title}">'
            f'<title>{title}</title><style>.a{ORIGIN}{style}{REDUCED}</style>{TILE}{BUBBLE}{inside}</svg>\n')

# Ready: a four-point spark, breathing slowly enough not to pull the eye during a call.
ready = svg('WorkspaceGPT: ready',
    f'<path class="a s" d="M20 14.5Q20.6 18 24 18.5 20.6 19 20 22.5 19.4 19 16 18.5 19.4 18 20 14.5Z" fill="{GREEN}"/>',
    '.s{animation:breathe 3.2s ease-in-out infinite}@keyframes breathe{50%{transform:scale(1.3);opacity:.7}}')

# Thinking: three dots that rise in turn.
dots = ''.join(f'<circle class="a d d{i}" cx="{x}" cy="18.5" r="1.8"/>' for i, x in enumerate([15.8, 20, 24.2]))
thinking = svg('WorkspaceGPT: thinking', f'<g fill="{GREEN}">{dots}</g>',
    '.d{animation:hop 1.1s ease-in-out infinite}.d1{animation-delay:.15s}.d2{animation-delay:.3s}'
    '@keyframes hop{0%,60%,100%{transform:translateY(0);opacity:.55}30%{transform:translateY(-2.5px);opacity:1}}')

# Listening: four bars that bounce, like a voice meter.
bars = ''.join(f'<rect class="a b b{i}" x="{x}" y="{y}" width="2" height="{h}" rx="1"/>'
               for i, (x, y, h) in enumerate([(14.2, 16, 5), (17.6, 14.5, 8), (21, 15.5, 6), (24.4, 16.5, 4)]))
listening = svg('WorkspaceGPT: listening', f'<g fill="{GREEN}">{bars}</g>',
    '.b{animation:eq .8s ease-in-out infinite}.b1{animation-delay:.15s}.b2{animation-delay:.3s}.b3{animation-delay:.45s}'
    '@keyframes eq{50%{transform:scaleY(.3)}}')

for name, text in [('cue-ready.svg', ready), ('cue-thinking.svg', thinking), ('cue-listening.svg', listening)]:
    open(os.path.join(out, name), 'w').write(text)
    print(name, len(text), 'bytes')
