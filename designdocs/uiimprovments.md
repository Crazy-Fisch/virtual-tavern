## ui usage
instead of rightclicking the deck ui for context, players expect to draw a card when just left clicking on the deck ui.
deck still has a righclick context menu with "shuffle".
also dragging a card over the ui zones should add them to the top of the zone, eg deck, graveyard, hand, exile.
draggin a card from hand has it "vanish" underneath other cards in hand. currently dragged cards should render on top of other cards
(even those in ui zones).
hand size is also potentially a problem, hand sizes can get pretty large, there should be a scrolling function when the width would increase 
too much the cards are not visibile anymore behind its container width but players can scroll up/down to move the container left right 
revealing the other cards.
after signing in (guest or real) players see the menu screen not imediately the play screen.

## camera
the camera should be a bit closer to the table for better card visibility, or increase the size of cards again.

## z fighting
lets implement z fighing fix with option A from `X:\CodeProjects\Web\VirtualTavern\designdocs\poslishing_results.md`

## decks 
currently the deck menu is not available for guest players, we do want it to be available for guest player but deck only get saved
locally. upon creating an account we can sync local decks and persist them. guests might loose their decks thats okay.
in the deck creating menu, rightclicking a deck has another context option to "rename" the deck (with persistance).
also a simple left click on a deck opens the deck view (it uses the while page). it just shows a scrollable grid of every card.
(use card database, load images in cache to display them, white placeholders for images that arent loaded yet or pink for not found at all)
we can click "<- back" where the back to menu button is to get back to the deck overview.
for a nice polish the background of the deck objects (squares with the name and counter) will be the image of the first card in the decklist
(since it is not square it shouldnt be distorted but rather a cutout look as if the square is transparent and the card lies behind it).

## room handling
currently when I create an account/ login with an account it still says "Signed in as Guest".
when creating an account, players should choose a username that gets used, no username checks tho (everything is fine, unless duplicates).
also when joining a room only guests can enter a display name
registered players will use their username.
when creating a room the name shouldnt be optional but require only 3 characters, no other verifications.
while in the room it should display the room name, and the room code nexto it.
