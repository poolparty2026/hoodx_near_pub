---
name: hoodx-brand
description: hoodx brand rules (colours, type, the Hoody mascot and its moods, layout patterns, voice and claim limits). Use whenever making or changing anything people will see as hoodx — app screens, the check page, README, demo video frames, X posts, slides, share cards, PDFs or diagrams — so it looks and reads like the October 2026 product overview.
---

# hoodx brand

Derived from `the October 2026 product overview PDF` (product overview, October 2026). Hex values were read from the PDF itself. Anything marked **Derived** is not in that document and was worked out from it; change it freely if the team decides otherwise.

## Core idea

hoodx is a friendly, soft, pastel brand for a serious DeFi tool. A cute mascot and candy colours sit on top of plain, exact, numbers-first writing. The cuteness makes privacy feel approachable. The writing keeps it credible. Never let the cute side leak into the claims.

## Colour

### Brand palette (from the PDF)

| Token | Hex | Role |
|---|---|---|
| `navy` | `#2B2D5B` | Ink. Headings, body text, every outline and border, the dark footer band |
| `mint` | `#7ED9C3` | Primary. Hoody's main colour, table headers, step 1, "Now" |
| `lavender` | `#B9A6F5` | Secondary. Step 2, "Next", the creator share |
| `peach` | `#FFC9B5` | Tertiary. Step 3, "Later", hoodx's platform share |
| `butter` | `#FFE9A0` | Highlight. Step 4, pill badges, the tagline chip |
| `sky` | `#BFE6FF` | Accent. Water band, bubbles, the "Wow" mood |
| `pink` | `#FF8FA8` | Accent. Cheeks, the "Cute-rekt" mood, the share card |
| `cream` | `#FFFAF3` | Page background |
| `muted` | `#6B6D8F` | Secondary text, captions, footers |
| `white` | `#FFFFFF` | Table cells and card fill |

Tints used for zebra rows and soft backgrounds: mint `#E6F7F2`, lavender `#EFEAFD`, peach `#FFEFE8`, butter `#FFF6D6`.

Small details: Hoody's tongue is `#FF6F8E`, the cheek blush is `#FF9FB2`, the mint highlight is `#9EE2D2`.

### Rules

- **Navy is the only ink.** Use it for text, outlines and arrows. No pure black and no grey borders.
- **Pastels are fills, never text.** Their contrast on cream or white is too low to read. Put navy text on a pastel fill.
- **Colour has a fixed order:** mint, then lavender, then peach, then butter. Use it for numbered steps, roadmap columns and any sequence. Sky and pink are extras for illustration.
- **The fee split has fixed colours:** joiners mint, creator lavender, hoodx peach. Keep them the same everywhere, so a split bar reads the same on every screen.
- **Page top stripe:** a thin bar across the top of each page, mint for 55%, lavender for 25%, peach for 20%.

### Dark UI (Derived)

The overview asks for a "dark, fast, mobile-first" app with a "fast dark terminal UI", but it is printed on cream. For the app, flip the palette:

| Token | Hex | Role |
|---|---|---|
| `bg` | `#1C1D3D` | App background (navy, darkened) |
| `surface` | `#2B2D5B` | Cards and panels (brand navy) |
| `surface-2` | `#3A3C6E` | Raised items, hover |
| `text` | `#FFFAF3` | Main text (cream) |
| `text-muted` | `#A9AACB` | Secondary text |
| `line` | `#4A4C80` | Borders |

On dark, the pastels can carry text and numbers, because they read well on navy: mint for gains and "matching", pink for losses and "not matching", butter for warnings. Hoody keeps its navy outline and gets a 2px cream halo so it shows on the navy background.

Tokens for both themes are in `assets/tokens.css`.

## Type

- **The PDF uses Helvetica only**, in regular, bold and bold oblique. On the web, use `"Helvetica Neue", Helvetica, Arial, sans-serif`. Don't add a display font.
- **Wordmark:** "hoodx" in Helvetica Bold, navy, sentence case, tight. Never all caps, never italic.
- **Headings:** bold, navy, sentence case ("What hoodx is", not "What hoodx Is").
- **Eyebrows and subtitles:** bold, all caps, `muted`, used sparingly ("THE AUTONOMOUS LP AGENT FOR NEAR", "NOW / NEXT / LATER").
- **Bold oblique** is for one thing only: a pull quote or the positioning statement.
- **Numbers:** use tabular figures in the app (`font-variant-numeric: tabular-nums`). Always show percentages and amounts as exact figures, never rounded (no split number is shown until gate 5 is settled).

## Shapes and layout

- **Rounded, outlined boxes.** Cards, tables and pills have a 2px navy outline. Cards and tables use a 10 to 12px radius, and pills are fully rounded.
- **Numbered section chip:** a small rounded square filled in the section's sequence colour, with a navy outline and the number in navy bold, next to the heading.
- **Tables:** a header row in a pastel with navy bold text, white and tinted zebra rows, thin lavender rules inside, and a navy outline outside.
- **Tagline pill:** butter fill, navy outline, bold navy text, with items split by ` * `, for example "Agent-run * Private strategies * Any-chain".
- **Callout:** a rounded box in a butter or mint tint for the positioning line or taglines.
- **Waves:** stacked wavy bands of sky, mint, lavender and navy at the bottom of a cover or hero. Use them for covers, heroes and share cards only, not inside the app.
- **Sparkles and bubbles:** four-point stars (butter, lavender, peach) and pale sky bubbles around Hoody on covers.
- **Page footer:** a dotted lavender rule, then "hoodx - autonomous LP agent + private strategy marketplace on NEAR" in muted text, the page number in navy bold, and a small Hoody drop.
- **Header:** a small Hoody next to "hoodx" in navy bold, top left.
- **Diagrams:** rounded pastel boxes with navy outlines, navy arrows, and Hoody in the middle of a cycle.

## Hoody, the mascot

Hoody is a little droplet who keeps your range secret.

- **Shape:** a water drop with a curled tip, two side nubs as hands, two small oval feet, and a soft oval belly. It has a thick navy outline, a top-to-bottom gradient (lighter at the top), and a white gloss oval on the upper left.
- **Face:** big navy eyes with two white highlights each, pink cheek blush, and a small pink tongue on the happy face.
- **Belly mark:** a `[•]` viewfinder bracket in white, a quiet nod to "private, watched by no one".
- **Friends on the cover:** smaller drops in sky, lavender (with a bow) and peach (with a crown). Use them as background characters, never instead of Hoody.
- **Reference art:** `assets/hoody-happy.svg` is a vector Hoody in the Happy mood, derived from the PDF. Use it as the base for other moods and sizes.

### Six moods

Each mood has a set colour. Use the mood that matches the state you are showing.

| Mood | Colour | Face | Use it for |
|---|---|---|---|
| Happy | mint | open eyes, smile, tongue | Default, success, strategy live |
| Wow | sky | open eyes, small "o" mouth | New, reveal, "rules unlocked" |
| Shh | lavender | closed arc eyes, finger on lips, padlock | Private, hidden rules, viewing key locked |
| Hype | butter | sparkle-star eyes, big smile | Fees earned, a strategy closed in profit, launch |
| Sleepy | peach | closed eyes, "z z" | Idle, out of range, waiting, empty state |
| Cute-rekt | pink | teary eyes, frown | Errors, losses, refusals, "not matching" |

**The Shh gesture**, a finger on the lips, is the brand's privacy sign. Use it wherever something is hidden until close or until a key is bought.

Don't use Hype next to a profit claim. Cute-rekt must still show the real number.

## Voice

- **Short, plain and exact.** For example: "One tap to zap in or join a strategy. The agent sets and manages the range."
- **Numbers before adjectives.** Write each share as an exact figure, never "a fair split" (no split number is shown until gate 5 is settled).
- **One action per screen,** with the verb on the button: Zap, Join, Manage, Close, Create.
- **Show every fee before a confirm,** in the same words every time.
- **Speak to "you" and "your LP agent".** Joiners, creators and followers are people, never "users".
- **Taglines to test:** "Your LP agent. Private by default." / "LP in secret. Win in public." / "Stay in the hood." (a line to test, not final) For the hackathon entry, use: "Follow a private LP strategy, and prove the agent did what it promised."
- **Product words:** zap, range, rebalance, guardrail, strategy, creator, joiner, follower, viewing key, check page, close, split. Use the same word for the same thing everywhere.

### What we claim, and what we do not

The brand must never promise more than the product does. This applies to every page, post and screen.

- **Claim:** rules that are committed, private until close or until a viewing key is bought, and checkable afterwards. Claim private funding only where the demo shows it.
- **Never claim:** that the agent makes money or beats the market, hidden pool positions, full anonymity, or that a viewing key cannot be resold.
- **Never write:** "unstoppable" about Intents (it is only fine as the name of the "Unstoppable DeFi" track), "harness" in a way that implies a link to NEAR's own work, or agent volume figures.
- When "Win in public" appears, pair it with public profit and loss, never with a promised return.

## Name

The name is cleared (D62). Write "hoodx on NEAR" or "the hoodx LP agent" the first time the name appears in public material.

## Checklist before you ship anything visual

1. Navy ink only, pastels only as fills (or as text on dark).
2. The fee split is mint, lavender and peach, with exact numbers.
3. Sequences follow mint, lavender, peach, butter.
4. Hoody's mood matches the state, and Shh marks anything private.
5. Rounded shapes with 2px navy outlines, and no hard black borders.
6. No profit, anonymity or "unstoppable" claim.
7. Sentence-case headings in Helvetica, with "hoodx" written in full.
