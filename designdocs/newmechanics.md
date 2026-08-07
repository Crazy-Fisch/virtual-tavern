## counter
we need one more counter type, we have +1/+1 and -1/-1.
now we will add a simple x counter.
it should behave like the +1/+1 counter but it only displays {number}x eg (1x or 2x or 3x),
minimum is 1x. it also sticks to cards.
if possible make it a squared looking 3d model.

## scrying & other actions
in many card games we need to modify top x cards of a deck.
right clicking the deck now has more options.
reveal (with submenu reveal [1-5, x]), x requires an input with a positiv int number.
the results 1-5 or the number from x will reveal the top number cards from the deck to the local player.
the view is like the search view when adding cards to the game, or viewing related cards.
top left card is the first card from the deck, bottom right the last from the x revealed cards.
a small lable in the top left that says "first", and a lable bottom right "last" to indicate it.
underneath the view are four zones, "hand", "deck", "bottom", "graveyard".
dragging a card over the zone puts it onto its appropiate zone.
a "undo" button under the zones lets the player undo their last action, all the way back to the start of the reveal action.
putting cards back on top works like it works with real cards, the last card to be put back on top is the first on the deck (stack).
same for the other zones.

## dice objects
lets color them in [green, blue, red, yellow].
lets also animate their text display numbers, instead of showing the result during the animation, it shows different numbers 
in its appropiate range during the animation, only at the end it "decides" for the result, giving a more random impression.
(d6 is fine as is).
