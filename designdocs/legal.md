## legal usage of api
because the scryfall api we are using states we cannot create new games using its data, we wont.
instead we will use a workaround.
instead of providing the api, we will provide an api usage.
so for this app to work we will keep all functionallity but the user has to tell what api to use.
initially no card data is available, in the deck overview if no api is deposited, the user will have to do so.
a button will open a modal with a text field add/cancel butttons where the player adds their api of choice (it can be any other).
then it gets saved temporary for guests and in the users account info of registered users.
they can later change/edit their api the same way they added it initally.
then, the app will use the user provided api instead of a static app level api.
