# Cuttle Web roadmap

Features we plan to add. The playable beta is live at https://apismellow.github.io/cuttle-web/. Requirements and decisions live in `docs/PRD.md` (see the §10 amendments), `docs/SPEC.md` and `docs/design.md`.

## Next

- **Theme picker.** A menu control to choose the deck look, remembered between visits. The first theme after the default vector cards is Mythic (below).
- **Learn-as-you-play help.** A short rules screen, plus one line under each one-off that says what it does ("5: draw two", "9: send a card back to its owner's hand"). Aimed at a first-time player.
- **Clearer recaps.** Every recap says what actually happened: which cards were drawn, and what a one-off did.
- **Desktop polish.** Larger labels in the desktop column and full keyboard play. Hand cards already lift on hover, and the lit play zones can be reached with Tab.

## Themes

Players will pick a deck look. Every theme keeps the rank and suit readable in the upper-left corner at phone size, and falls back to the plain vector cards if its art fails to load (PRD A-6, R23).

- **Mythic (first):** a full 52-card painted deck in the spirit of classic fantasy card games. Colour follows what each rank does: the Ace wipes the board, the 2 counters, the Jack steals. Sideways goggles mark a glasses 8.
- **Stained glass:** a hand-drawn vector deck. It's a candidate to become the standard look.
- **Webb table:** playmats and card backs from James Webb Space Telescope imagery (IC 348), which pair with any theme.
- **Cathedral (later):** palette-knife painting, gold light against violet shadow. It may become a full theme, or a suit style paired with stained glass.

The work-in-progress source art and its review sheet are on the `art/source-assets` branch.

## Later

- **Two-phone online play.** Each player uses their own phone, and a small server relays moves and keeps each hand hidden. This is the v2 design in PRD §7.
- **Offline play.** A service worker so the installed home-screen app works without a connection.
- **Player colours:** an optional colour for each player, possibly tied to theme suits.
- **An accessibility pass:** screen-reader labels for every card and action, and contrast checks for every theme.
