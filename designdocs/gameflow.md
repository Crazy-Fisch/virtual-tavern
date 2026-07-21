## deck creation
players create their deck beforehand from the menu screen.
deck are a basic json file with a name and a decklist.
an entry in the decklist is an obejct eg { "card": "Water Worm", "count": 1 }
for phase 1 player can only import decklists.
there will be different formats comming from sites like scryfall, archidekt, etc. or just a play txt list with names
goal is to have an efficient large covering deck importer that can create a deck object with all its cards.
players can see what decks they have in the deck overview (just use squares that have the deck name inside and a card counter number below).
that will be plain angular/html.
rightclicking on such a deck entry show a context menu where players can delete the deck.

## resources
we will use scryfall api to download the json list of all cards using this uri `https://data.scryfall.io/default-cards/default-cards-20260719091104.json`
in a local cache we will store that file. we can later introduce an update system.
for now upon application start we check and load this file. it will be our database.

## entering a room
when entering a newly created room (session not running), players dont have their game ui for zones, etc.
they instead have a button bottom right that says choose deck. from there, they can select one of their deck previously created.
the deck will then load into game and the game ui will initialize for that player.
when a deck gets loaded we can already start loading all the images into cache that will be used for the cards, loading them from our database json,
where we find the image uris.

## cards
when a card gets put into play or changes, it will retriev its image from cache->database and load it.
