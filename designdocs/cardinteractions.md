## Interactions

Hover: mouse over a card will highlight the edges/card
Implementation: RayCasting and Shader we can tint the entire mesh slightly white for phase1

Left Click: left clicking on a card intents to move a card, it will clear highlights, an make the card move along the cursor.
clicking on a valid position eg. the table will place it onto it at that position. no rotation changes are made. only moving XZ while 
hovering on a elevated Y level.
Implementations: RayCasting for detecting mouse on card. use camera through cursor onto table. when activley moving a card
we can use ray from mouse straight down so the card can hover over a placeable area.

Right Click: right clicking on a card opens a context window next to it. 
Options: 
-view: opens a large view of the card
-rotate: rotate it 180, facing same upward direction, to change view for players.
-flip: rotates it 180 around itself changing face up or face down.
-related: opens another context window listing its related cards.
-delete: removes the card from game entirely.
-tba: tba
Implementation: RayCasting, card objects will have a CardContext object and a CardState to save their position, rotation, and 
show related cards etc., view should be basic angular/html not three framework.

## Detail
Card should be able to be placed ontop of each other.
Hotkeys should be available to trigger actions when a card is hovered (should be configurable later)
