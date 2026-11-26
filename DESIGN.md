# Snagly — design plan

## Subject

A private, local tool that turns YouTube playlist links into a tidy MP3 library, or MP4 video up to 4K.
Audience: one person, on their own machine. Job: paste links, watch it work, find the music.

## Color (Apple system palette, used sparingly)

- paper `#F5F5F7` — page base
- surface `#FFFFFF` — panels
- ink `#1D1D1F` — primary text
- muted `#5F5F64` — secondary text
- faint `#6E6E73` — tertiary text, still WCAG AA on paper
- hairline `#D2D2D7` — structural lines only
- signal `#5E5CE6` — Apple system indigo; live progress, active mode, pickers
- signal-soft `#EEEDFD` — active row tint
- action `#5E5CE6` — the one primary button (white label)

Dark mode mirrors this with `#1C1C1E` base, `#2C2C2E` surface, `#F5F5F7` ink.

## Type

One family: Inter (SF Pro surrogate), weights 400/500/600/700.
No second display face. Personality comes from scale and tracking, not font swapping.

- Display 52px / -0.045em / 600
- Section 24px / -0.02em / 600
- Body 16px / 1.55
- Caption 13px / 1.4
- Tabular numerals on all counts, sizes, track numbers.
  Everything left aligned. Measure capped near 62 characters.

## Layout

Slim top bar (mark + name, root folder, theme).
Hero: short headline + one-line explanation, left aligned.
The input panel is the hero object — large, quiet, focused. Below it, an active-job
strip with a waveform that fills as tracks complete. Library is a horizontal filmstrip
of cover art, not a grid of identical cards.

```
┌────────────────────────────────────────────────────────┐
│  ≈  Reel                    Library: Worship Pad   ◐   │
├────────────────────────────────────────────────────────┤
│                                                        │
│  Your music, collected.                                │
│  Paste a playlist link. Snagly pulls the audio, tags     │
│  it, and files it away.                                │
│                                                        │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Links, one per line                              │  │
│  │                                                  │  │
│  │  https://youtube.com/playlist?...                │  │
│  │                                                  │  │
│  │  MP3 · 5 at a time        [ Download audio ]     │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  ▁▂▄▆█▆▄▂▁  3 of 12 · "C Pad"            [pause]      │
│                                                        │
│  Library                                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐         │
│  │  cover │ │  cover │ │  cover │ │  cover │         │
│  └────────┘ └────────┘ └────────┘ └────────┘         │
│  Drones 7   Analog 6    Peaceful 5  Spontaneous 4      │
└────────────────────────────────────────────────────────┘
```

## Principles

1. Covers are the content. Chrome stays neutral and recedes.
2. Progress is information. The waveform encodes real completed tracks, nothing else.
3. One accent, one motion moment, lots of space.
4. Plain verbs in the UI: "Download audio", "Open folder", "Retry failed".

## Review against generic defaults

- Not cream + serif + terracotta. Not near-black + acid accent. Not broadsheet.
- Library is a filmstrip of real artwork, not a grid of identical soft-shadow cards.
- No ALL-CAPS eyebrows, no middle-dot meta strings, no arrow-suffixed buttons.
- Distinctive element is the waveform, which is only there because this app is about audio.
- Apple HIG: clarity (plain labels), deference (art dominates), depth (hairlines, one
  elevation level), system typography, spacious, one restrained entrance animation.
