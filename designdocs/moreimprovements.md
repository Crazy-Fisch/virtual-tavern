## persistance2
world_objects can also be cleaned up from the database after a room is removed.

## item errors
adding items logs
RuntimeError: NG0950: Input "state" is required but no value is available yet. Find more at
_Item.spawn item.ts:421:19
and nothing shows up

## ui 
for the play ui Id rather use tabbed navigation for join room / create room.
same for the sign in mask, Id use a tab for login / sign up.
continue as guest can still be present in both at the bottom.

## tokens
currently searching for card in game doesnt show any tokens in the results. we need to add them to the database aswell.

## related cards
related cards feature is currently missing.
for a card object when using the correct json data blob it already holds releated cards like tokens.
thoose should be added to the card obejcts info and be used for related cards.
searching cards and realted cards should also be able to be dragged onto the table, we can then remove the "to table" etc action buttons.

## card drag
when dragging multiple cards that are selected, they keep their tapped state, size etc. 
when dragging a single card it gets smaller during dragging and always is untapped.
Id prefer the style of dragging we have when dragging multiple cards, id want that for single cards also.

## untapping
when a turn starts, players want to usually untap all their cards.
Id want an action button, near the lifepoints, reveal hand button, that says untap (shortcut u) and untapps all cards that that player owns.
