-- 0079: a portal's old links keep working after its URL changes.
--
-- WHY. A portal's URL is its token (/portal/<token>), and the token is the
-- only thing that finds it. Changing it used to kill every link the client
-- already had — bookmarks, and every link in the introduction emails and
-- texts sent before — with nothing to forward them. So the OS refused to
-- change it at all, and a real request (Amy, 16 Oct: Jeff Cook's URL) could
-- not be done from the OS. Now an old token is remembered and the portal
-- forwards it to the current one (app/portal/[token]/layout.tsx).
--
-- WHAT. Purely additive: one new table and one trigger. No existing row is
-- touched, and nothing happens until a portal's URL is next changed.
--   portal_token_aliases   old token -> the portal it belonged to
--   the trigger            on every change of clients.portal_token, by any
--                          app, keeps the old token; refuses a new token that
--                          is another portal's old one (it would take over that
--                          portal's old links); and when a portal goes back to
--                          one of its own old tokens, that one is current again.
--
-- A portal deleted takes its old tokens with it (on delete cascade).

create table if not exists public.portal_token_aliases (
  old_token  text primary key,
  client_id  uuid not null references public.clients(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now())
);
create index if not exists portal_token_aliases_client_idx on public.portal_token_aliases (client_id);

-- Read and written by the server only (service role); nothing for a browser.
alter table public.portal_token_aliases enable row level security;

create or replace function public.portal_token_alias_on_change()
returns trigger
language plpgsql
as $$
begin
  if new.portal_token is not distinct from old.portal_token then
    return new;
  end if;

  if new.portal_token is not null and exists (
    select 1 from public.portal_token_aliases a
    where a.old_token = new.portal_token and a.client_id <> new.id
  ) then
    raise exception 'That portal link was used by another portal — pick another.'
      using errcode = '23505';
  end if;

  -- Back to one of its own old links: it is the current one again.
  delete from public.portal_token_aliases
  where old_token = new.portal_token and client_id = new.id;

  if old.portal_token is not null then
    insert into public.portal_token_aliases (old_token, client_id)
    values (old.portal_token, new.id)
    on conflict (old_token) do update set client_id = excluded.client_id, created_at = excluded.created_at;
  end if;

  return new;
end;
$$;

drop trigger if exists portal_token_alias_on_change on public.clients;
create trigger portal_token_alias_on_change
  before update of portal_token on public.clients
  for each row execute function public.portal_token_alias_on_change();
