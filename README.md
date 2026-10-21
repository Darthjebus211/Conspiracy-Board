# Conspiracy-Board
Foundry VTT module for a conspiracy board controllable by players
# Conspiracy Board 2.8.0 (Foundry VTT v14)

## Install / upgrade
Replace `Data/modules/conspiracy-board/` with this folder. Existing cards and strings are kept.

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
