-- Deck editor: let an account update its own decks (name + list). Before this
-- the decks table had select/insert/delete policies only, so renames and edits
-- were silently refused by row-level security.
create policy "decks_update" on public.decks
  for update to authenticated
  using (owner_id = auth.uid())
  with check (
    owner_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );
