## bugs
-viewing a card has a ui border around the card, it is not fitting the whole card tho and only half as wide as the card.
-dice and coins and counters arent working properly, remove them entirely for now.

## miscellaneous
-card are too big, they should be ways smaller like real cards.
-playing cards from the ui layer should work like real cards on the table, not by clicking, by dragging them onto the table.
-the camera should be more like a bird view from the top. I do want a slight angle like your sitting at the end of a table but to reduce
the perspective shift it should be far mor from the top.
-placing card next to each other produces Z fighting. what solutions are there? I dont want to offset every card by 0.001 per card already played that feels bad.
find solutions and document them in the result file but dont implement any yet.
-persist decks to logged in players (guest cannot use this feature), the decks menu from the signed out screen can be removed
-currently all players at at the same table side, for now thinking about 1v1, the two players are positioned opposite to each other.
the room creator will have its current side of the table, any other player joining will be at the other end. (dont restrict room sizes for now)
