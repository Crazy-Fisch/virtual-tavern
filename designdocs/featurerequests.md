## Networking
Networking:
card on the table should be a networked state, every player sees the same cards in the same states. joining a room at a later time 
should adequately sync the states so they too can see the true state.

## History
In a card game it is important to keep an overview of what happened there for the chat will be the history.
when any user takes an action a chat message will appear. to distinguish it it will be plain white starting with the username
<username>: <action>
eg: crazyfisch: added Water Worm
while user typed messages will be colored.

## Zones
Card games have different zones. eg deck / graveyard etc
these are represented by ui html/angular.
right clicking a zone shows context actions like shuffle/draw

## Cards outside the Game
Some card should live in another layer like related cards already do.
Players have cards in hand/their deck/ other zones.
theese are open or closed to other players. players should see other player hand card or decks but can examine their graveyards.
I should see my hand cards like im actually holding cards in my hand (like any other pc card game does it), I can then drag them from 
theese zones into game.
the pure contents need to be available over the network tho as other players should know the sizes of zones and under certain conditions
are allowed to look at them.
this could be realized as basic html/angular instead of using three.
(the only thing for visuals might be a model representing the deck, skip for now)

## Adding cards
players can add card to the game, right clicking anywhere were it doesnt trigger a card action etc. opens a util window.
were players can search for any card name, results will be shown in a scrollable area below the search bar. (6 cards are visibale 3x2 then scrollable if more)
these cards can be added to the game aswell

## Other game objects
Card games often need other counters and identification objects.
the util window from ## Adding cards ## can also add other object to the table
-dice (d6, d12, d20)
-coin
-+1/+1 counter
--1/-1 counter
-<number>x counter

