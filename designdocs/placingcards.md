## mouse interaction
hovering a card it gets highlighted.
now instead of click to move a card I want to drag to move a card.
clicking on a card should now "tap" the card, rotate it on its y plane by 90deg. its card state should update "tapped: boolean"
when it is already tapped it gets untapped: y plane by -90deg.
now to move a card you simply drag it and it gets placed automatically when released. if it cannot be placed where it has been released
it should snap back to its point from where it got moved from.

## placing cards
currently the position a card being placed is determined by a ray cast from the cards origin going straight down.
that doesnt align with the camera view tho.
we want the card to be placed where I actually clicked.
to archive that we will use a transformation as in Unitys API using `Camera.ScreenPointToRay(Vector2 mousePos)`
that way we simulate a ray coming from the camera, through the mouse onto the table.
