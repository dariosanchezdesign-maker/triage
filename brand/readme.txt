Triage — logo assets
Official mark: the necked (welded) frame. Symbol geometry, 100-unit box:
  left bar   x12 y18 44x26 r13
  right bar  x59 y18 26x26 r13
  stem       x37 y46 24x46 r12
  filter     gaussian blur 3.2 + alpha 26 / -11 (the weld)
Lockups contain the symbol and the word "Triage" only, set in Host Grotesk 600,
cap height = the symbol's crossbar-to-foot height (type size = 1.04 x symbol box),
gap = 26 units. Convert the text to outlines before print handoff, or install
Host Grotesk; the SVGs reference the webfont for browser use.
Below 40px use the unfiltered pills; below 20px use triage-appicon.svg.
Animated files: 4.2s loop, for reasoning / loading / splash only.
Black on white or white on black. No greys, tints, outlines, rotation or stretching.

Files
  triage-symbol-black.svg / -white.svg            symbol only
  triage-symbol-animated-black.svg / -white.svg   4.2s loop
  triage-lockup-horizontal-black.svg / -white.svg symbol + "Triage"
  triage-lockup-stacked-black.svg / -white.svg    symbol + "Triage"
  triage-lockup-*.png                             same lockups, 3x raster, type already rendered
  triage-appicon.svg                              rounded tile, symbol knocked out

Note on the lockup SVGs: the word is live text referencing Host Grotesk, so it is
editable but needs the font (or an outline conversion) to render correctly outside a
browser with the webfont. The PNGs are the safe drop-in when you cannot install it.
