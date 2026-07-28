## choosing deck
the ui when choosing a deck at the start of a game should also show the background image of the first card, similar to the deckbuilding ui

## ui
currently I can only see my own zones as ui and my own hand.
however player should be able to see the zones of the other player. 
when a player confirms his deck there will be zones for on the other side for the other player.
the deck zone of the other player only shows how much cards are left, the graveyard and exile are explorable like your own.
additionally players have a health counter that is increasable with a "+" button to its right
and decreasable with a "-" to its left. 
initially, before the counter and buttons are visible, two buttons vertically ordered are visible with "20" and "40" as options, setting
the starting health to that amount.
the local player can choose and change its own health other player can only see the amount.

## size
increase the size of the zones to 150% of its current size.

## hand ui
the hand of other players should be represented with cards like their are, but only the backside is visible.
currently cards can take place left and right as much as they want, instead after 10 cards the scroll behaviour should take action.
cards beyond 10 wont be visible. the total width of the current 10 visible cards wont exceed the middle 50% of the screen so it doesnt cover the zone uis.
there will be an action button to the left of the hand ui that can toggle to reveal your entire hand to the other players.
this toggle will always set all cards to be revealed or not, regardless of the individual states of single hand cards.

## context menu for hand
right clicking a card in your hand will now open a context menu, where you can toggle to reveal a single card.

## zone ui
currently cards in zones have a button "to hand", instead they should also be draggable into other zones or onto the table.

## card material
card objects on the table look far more faded out then cards being dragged.
can we improve the look of card objects to be more like when they are basic html?
