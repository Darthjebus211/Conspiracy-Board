# Conspiracy Board 2.10.2 (Foundry VTT v14)

## Install / upgrade
Stop Foundry (or return to Setup), **delete** `Data/modules/conspiracy-board/`, then put this folder in its place — copying over the top can leave a stale pack behind. Existing cards and strings are kept.

## Changes in 2.10.2
- New **compendium of macros** ("Conspiracy Board Macros") in the module's Compendium tab, holding **Conspiracy Board: Change Drawing Author** — a GM script macro that reassigns the author of every drawing on the current scene to a user of your choosing, GMs included.
- Fixed the macro compendium appearing empty: the pack is now a proper database folder (`packs/macros/`), and if it ever opens empty the GM's client refills it from `data/macros/` on load.

## Changes in 2.9.0
- New **lone pin** tool: place a pin with no card, to tie strings to as a junction or waypoint. Pins can link a journal and are moved or deleted like any drawing.

## Changes in 2.8.0
- New **character clues**: pin an actor's portrait or token art as a clue, with a caption (the character's name by default) and an optional linked journal. They take strings like any other clue.

## Changes in 2.7.3
- Comment clues now have their pin (and string) on the top-left corner instead of the top centre, so it no longer covers their small text.

## Changes in 2.7.2
- Fixed strings and pins not drawing at all: the **String sag** setting was documented but never registered, so reading it threw on every redraw.
- Player requests now use the server-supplied sender id instead of one in the message, so a player can't impersonate the GM.
- A journal linked while creating a clue is now permission-checked, the same as linking one later.
- Players can only rename a clue that has no text (to adopt its journal's name); a non-active GM can now rename too.
- Strings can only be tied between clue cards; empty or malformed clue requests are ignored.
- Long clues in large type no longer spill out of their card.
- Errors while saving a change are logged instead of failing silently.

## Changes in 2.7.1
- Fixed strings no longer being drawn. The overlay that draws them is now destroyed when a canvas tears down and rebuilt for the next scene, instead of being reused after its graphics had been released. It is also added on top of the interface so it can't be hidden.

## Macros

The module ships a compendium of macros. Open the **Compendiums** tab, open **Conspiracy Board Macros**, and drag a macro onto your hotbar, or right-click it and choose *Import*.

- **Conspiracy Board: Change Drawing Author** (GM) — asks which user should own the drawings, then reassigns the author of every drawing on the scene you are viewing. GMs and assistant GMs appear in the list as well as players, so authorship can be handed to a GM or taken back from one. The dialog shows how many drawings are on each Scene Level and the first few current authors before you commit.

  Worth knowing: **author is not ownership**. Reassigning it re-labels who made a drawing; it neither grants the new author edit rights nor takes any away from the old one. Foundry forms an author id as `user.id.slice(0, 16)`, while drawings made from the setup screen can carry the full user id, so the macro recognises both.

## Clue types
| Type | Font size | Default colour |
| --- | --- | --- |
| Major | 34px | pale yellow |
| Minor | 24px | pink |
| Comment | 16px | pale blue |

## Module settings
- **Major / Minor / Comment clue colour** — a colour picker per type.
- **String colour** — colour of the string linking clues.
- **String sag** — how far the string droops between pins.

## Use
All tools are in the **Drawing Tools** toolbar (the pencil):
- **Thumbtack**: pin a new clue. Pick a type, then type text — or leave it blank with a journal picked and the journal's name becomes the title.
- **Spy (user-secret)**: pin a character. Pick an actor you can see, choose portrait or token art, and optionally a caption and journal. Double-click it to open its journal, or the actor sheet if no journal is linked.
- **Map pin**: place a lone pin at the centre of your view. Tie string to it like any clue; drag it to move, Delete to remove. Double-click to open or link a journal.
- **Open book**: link, change or remove the journal on the selected clue (shortcut: **J**).
- **Linked nodes**: link mode. Click two clues to tie string between them, or do it again to cut it.
- **Scissors** (GM only): cut every string on the scene.
- Double-click a clue to open its journal; Shift + double-click for the drawing settings.

## Notes
- A GM must be online for players to change the board: player changes are sent to the GM's client, which saves them.
- Linking a journal requires that you can view it. Cutting every string on a scene is a GM action.
- Macros: `game.modules.get("conspiracy-board").api` has createCard, createPortrait, createPin, linkJournal, toggleLink, clearLinks and redraw.
