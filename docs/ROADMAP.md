# Cuttle Web roadmap

Features we plan to add. The playable beta is live at https://apismellow.github.io/cuttle-web/. Requirements and decisions live in `docs/PRD.md` (see the §10 amendments), `docs/SPEC.md` and `docs/design.md`.

## Next

- **In-game menu (done 2026-09-29).** A menu button on every game screen opens Rules, Card style, Home (the game stays saved; Resume picks it up) and New game (asks first).
- **Card labels (shipped).** Cards on the table say what they're doing: a King shows the points its owner now needs to win (21, 14, 10, 7 or 5), a Queen shows it protects, a Jack on a stolen card shows it stole, and a glasses 8 shows it sees the hand. Tap a card in your hand and the action bar gives its name and what it does; the staging line and the card popover name it too. Every rank has a short name (the Ace is "Board Wipe", the 5 "Draw Two"), the Rules sheet uses the same names and wording, and a theme can rename any card. Labels stay readable at phone size and in both Classic and Mythic.
- **Learn-as-you-play help.** A short rules screen, plus one line under each one-off that says what it does ("5: draw two", "9: send a card back to its owner's hand"). Aimed at a first-time player.
- **Clearer recaps.** Every recap says what actually happened: which cards were drawn, and what a one-off did.
- **Desktop polish.** Larger labels in the desktop column and full keyboard play. Hand cards already lift on hover, and the lit play zones can be reached with Tab.
- **Menu-first settings.** Move options (card style, table mode, rules) behind the hamburger menu instead of selectors on the front screen, with a toolbar for common actions.

## Themes

**In progress:** a Card style picker on the home screen and in the in-game menu, with Classic (the vector cards) and Mythic, the first painted deck. The choice is remembered between visits. Mythic is the default; Classic available. Mythic has faces and a card back but no playmat yet. Every theme keeps the rank and suit readable in the upper-left corner at phone size, and falls back to the plain vector cards if its art fails to load (PRD A-6, R23).

- **Mythic (first):** a full 52-card painted deck in the spirit of classic fantasy card games. Colour follows what each rank does: the Ace wipes the board, the 2 counters, the Jack steals. Sideways goggles mark a glasses 8.
- **Card gallery (shipped).** Every Mythic painting, uncropped, one card at a time at https://apismellow.github.io/cuttle-web/gallery/. A standalone page in `gallery/` (see `gallery/README.md`).
- **Classic card redesign.** Rework the standard deck for legibility: a real card's proportion (about 5:7), a large serif corner index with the suit beside it, one big centre pip, plain white faces with a thin edge. Paired with a textured felt table.
- **New Classic card back:** the standard vector deck gets a new back design, replacing the current plain back.
- **Stained glass:** a hand-drawn vector deck. It's a candidate to become the standard look.
- **Webb table:** playmats and card backs from James Webb Space Telescope imagery (IC 348), which pair with any theme.
- **Cathedral (later):** palette-knife painting, gold light against violet shadow. It may become a full theme, or a suit style paired with stained glass.

The work-in-progress source art and its review sheet are on the `art/source-assets` branch.

## Later

- **Two-phone online play.** Each player uses their own phone. A small server runs the game and sends each phone only its own view, so each hand stays hidden. Decisions are in PRD §10 A-7 and the work plan is `docs/two-phone-plan.md`.
- **Offline play.** A service worker so the installed home-screen app works without a connection.
- **Player colours:** an optional colour for each player, possibly tied to theme suits.
- **An accessibility pass:** screen-reader labels for every card and action, and contrast checks for every theme.
